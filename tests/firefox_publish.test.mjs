import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorization, configuration, firefoxRelease, releaseProof, reviewerNotes } from '../scripts/firefox-store.mjs';
import { cliMode, digest, metadata, requestJson, verifiedArchive, verifiedSource } from '../scripts/firefox-release-utils.mjs';

const config = { issuer: 'test-issuer', secret: 'not-a-real-secret' };
const name = 'pvt-rc', guid = `${name}@gnaservicesinc.com`, version = '0.2.4';
const archive = Buffer.from('release'), source = Buffer.from('reviewer source');
const base = { config, name, guid, version, archive, source, notes: 'Release notes', approvalNotes: 'Build steps', wait: async () => {} };
const proof = releaseProof(archive, source);
const current = { id: 123, version, channel: 'listed', source: 'reviewer.zip', approval_notes: `Build steps\n\n${proof}`, file: { status: 'unreviewed' }, is_disabled: false };
function fixture(responses) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, `Unexpected request ${url}`);
    const body = responses.shift();
    return { ok: !body.http, status: body.http || 200, json: async () => body };
  } };
}
function uploaded(uuid = '1234567890abcdef1234567890abcdef') { return { uuid, processed: true, valid: true, channel: 'listed', version, submitted: false }; }

test('JWT uses a short lifetime, unique nonce, and correct HMAC', () => {
  const token = authorization(config, 10).slice(4);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const body = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(body.iss, config.issuer); assert.equal(body.iat, 10); assert.equal(body.exp, 70);
  assert.notEqual(authorization(config, 10), `JWT ${token}`);
  assert.equal(signature, createHmac('sha256', config.secret).update(`${header}.${payload}`).digest('base64url'));
});
test('AMO reviewer notes and multipart wire value stay within 3000 characters', async () => {
  assert.ok(!proof.includes('\n') && !proof.includes('\r'));
  for (const input of ['instructions'.repeat(1000), 'line\n'.repeat(1000), 'line\r\n'.repeat(1000), 'line\r'.repeat(1000)]) {
    const notes = reviewerNotes(input, archive, source);
    assert.ok(notes.length <= 3000); assert.ok(notes.includes(proof)); assert.ok(notes.includes('attached source ZIP'));
    const form = new FormData(); form.set('approval_notes', notes);
    const response = new Response(form);
    const wire = await response.text();
    const value = wire.slice(wire.indexOf('\r\n\r\n') + 4, wire.lastIndexOf('\r\n--'));
    assert.equal(value, notes); assert.ok(value.length <= 3000); assert.ok(value.includes(proof));
  }
});
test('missing credentials and invalid CLI modes fail safely', () => {
  assert.throws(() => configuration({}), /AMO_JWT_ISSUER/);
  assert.equal(configuration({ AMO_JWT_ISSUER: 'a', AMO_JWT_SECRET: 'b' }).issuer, 'a');
  assert.equal(cliMode(['--dry-run']), '--dry-run');
  for (const args of [[], ['--submit', '--status'], ['--unknown']]) assert.throws(() => cliMode(args));
});
for (const uuid of ['1234567890abcdef1234567890abcdef', '12345678-90ab-cdef-1234-567890abcdef']) {
  test(`listed submission supports AMO upload UUID ${uuid.length} characters and attaches source atomically`, async () => {
    const api = fixture([{ guid }, { http: 404 }, uploaded(uuid), current, current, current]);
    const result = await firefoxRelease({ ...base, fetcher: api.fetcher });
    assert.equal(result.state, 'unreviewed'); assert.equal(result.alreadySubmitted, false); assert.equal(result.reviewerSourceAttached, true);
    assert.equal(api.calls[2].options.body.get('channel'), 'listed');
    const create = api.calls[3].options.body;
    assert.equal(create.get('upload'), uuid); assert.equal(create.get('source').name, `${name}-${version}-firefox-source.zip`);
    assert.equal(create.get('license'), 'GPL-3.0-only'); assert.ok(create.get('approval_notes').includes(proof));
    assert.deepEqual(JSON.parse(api.calls[4].options.body).release_notes, { 'en-US': 'Release notes' });
    assert.ok(api.calls.every(call => call.options.redirect === 'error' && call.options.headers.Authorization.startsWith('JWT ')));
  });
}
test('upload polling preserves UUID and waits before version creation', async () => {
  const pending = { ...uploaded(), processed: false };
  const api = fixture([{ guid }, { http: 404 }, pending, uploaded(), current, current, current]);
  let waits = 0;
  await firefoxRelease({ ...base, fetcher: api.fetcher, wait: async ms => { assert.equal(ms, 10000); waits++; } });
  assert.equal(waits, 1); assert.equal(api.calls[3].options.method, 'GET'); assert.equal(api.calls[4].options.method, 'POST');
});
test('same submitted version is idempotent and never uploads again', async () => {
  const api = fixture([{ guid }, current, current, current]);
  const result = await firefoxRelease({ ...base, fetcher: api.fetcher });
  assert.equal(result.alreadySubmitted, true); assert.ok(api.calls.every(call => call.options.method !== 'POST'));
});
test('safe retry can repair missing reviewer source', async () => {
  const api = fixture([{ guid }, { ...current, source: null }, current, current, current]);
  await firefoxRelease({ ...base, fetcher: api.fetcher });
  assert.equal(api.calls[2].options.method, 'PATCH'); assert.equal(api.calls[2].options.body.get('source').name, `${name}-${version}-firefox-source.zip`);
});
test('status reports an absent release without upload or credentials in the result', async () => {
  const api = fixture([{ guid }, { http: 404 }]);
  const result = await firefoxRelease({ ...base, fetcher: api.fetcher, statusOnly: true });
  assert.equal(result.state, 'not-submitted'); assert.equal(api.calls.length, 2); assert.ok(!JSON.stringify(result).includes(config.secret));
});
test('wrong add-on identity never uploads', async () => {
  const api = fixture([{ guid: 'other@example.com' }]);
  await assert.rejects(firefoxRelease({ ...base, fetcher: api.fetcher }), /different add-on/); assert.equal(api.calls.length, 1);
});
test('wrong or malformed existing version, proof, channel, rejection, and disablement never upload', async () => {
  for (const changed of [{ id: '123' }, { version: '0.1.0' }, { channel: 'unlisted' }, { approval_notes: 'other release' }, { file: { status: 'disabled' } }, { is_disabled: true }, { file: null }]) {
    const api = fixture([{ guid }, { ...current, ...changed }]);
    await assert.rejects(firefoxRelease({ ...base, fetcher: api.fetcher })); assert.equal(api.calls.length, 2);
  }
});
test('invalid uploads never create a version', async () => {
  for (const changed of [{ uuid: '-'.repeat(36) }, { valid: false }, { channel: 'unlisted' }, { version: '0.1.0' }, { submitted: true }]) {
    const api = fixture([{ guid }, { http: 404 }, { ...uploaded(), ...changed }]);
    await assert.rejects(firefoxRelease({ ...base, fetcher: api.fetcher })); assert.equal(api.calls.length, 3);
  }
});
test('polling rejects a changed upload identity', async () => {
  const api = fixture([{ guid }, { http: 404 }, { ...uploaded(), processed: false }, { ...uploaded(), uuid: 'f'.repeat(32) }]);
  await assert.rejects(firefoxRelease({ ...base, fetcher: api.fetcher }), /different upload/); assert.equal(api.calls.length, 4);
});
test('missing source or rejected final confirmation fails rather than reporting success', async () => {
  for (const changed of [{ source: null }, { file: { status: 'disabled' } }, { approval_notes: '' }, { is_disabled: true }, { version: '0.1.0' }]) {
    const api = fixture([{ guid }, current, current, { ...current, ...changed }]);
    await assert.rejects(firefoxRelease({ ...base, fetcher: api.fetcher }), /confirmation/);
  }
});
test('network, authentication and invalid JSON errors exclude response secrets', async () => {
  for (const fetcher of [async () => { throw Error(config.secret); }, async () => ({ ok: false, status: 403, json: async () => ({ secret: config.secret }) }), async () => ({ ok: true, json: async () => { throw Error(config.secret); } })]) {
    await assert.rejects(requestJson(fetcher, 'https://example.com', {}), error => !error.message.includes(config.secret));
  }
});
test('reviewer ZIP is deterministic, complete, and excludes private/generated inputs', async () => {
  const release = await metadata();
  const temp = await mkdtemp(join(process.cwd(), '.release-test-'));
  try {
    const first = join(temp, 'first'), second = join(temp, 'second');
    for (const output of [first, second]) execFileSync('python3', ['scripts/package-source.py', '--output', output]);
    const filename = `${release.name}-${release.version}-firefox-source.zip`;
    const a = await readFile(join(first, filename)), b = await readFile(join(second, filename));
    assert.equal(digest(a), digest(b));
    assert.deepEqual(await verifiedSource(join(first, filename), release, join(first, 'SHA256SUMS.txt')), a);
    const entries = execFileSync('unzip', ['-Z1', join(first, filename)], { encoding: 'utf8' });
    assert.ok(!entries.includes('chrome-store.mjs')); assert.ok(!entries.includes('.git/')); assert.ok(entries.includes('pnpm-lock.yaml'));
    await writeFile(join(first, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${filename}\n`);
    await assert.rejects(verifiedSource(join(first, filename), release, join(first, 'SHA256SUMS.txt')), /checksum/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('Firefox archive verification rejects wrong versions, add-on identities and duplicate checksums', async () => {
  const temp = await mkdtemp(join(process.cwd(), '.release-test-'));
  try {
    const zip = join(temp, 'extension.zip'), sums = join(temp, 'SHA256SUMS.txt');
    for (const change of [{}, { version: '0.1.0' }, { browser_specific_settings: { gecko: { id: 'other' } } }]) {
      const manifest = { manifest_version: 3, version, browser_specific_settings: { gecko: { id: guid } }, ...change };
      execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("manifest.json",sys.argv[2]); z.close()', zip, JSON.stringify(manifest)]);
      const data = await readFile(zip), line = `${digest(data)}  extension.zip\n`;
      await writeFile(sums, line);
      if (Object.keys(change).length) await assert.rejects(verifiedArchive(zip, { version, guid }, sums), /differs/);
      else assert.deepEqual(await verifiedArchive(zip, { version, guid }, sums), data);
      await writeFile(sums, line + line); await assert.rejects(verifiedArchive(zip, { version, guid }, sums), /checksum/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
