// Submit a listed AMO update with reviewer source in the same version-create request.
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cliMode, digest, fail, isMain, metadata, pause, report, reportFailure, requestJson, root, verifiedArchive, verifiedSource } from './firefox-release-utils.mjs';

const origin = 'https://addons.mozilla.org/api/v5';
export function configuration(env = process.env) {
  if (!env.AMO_JWT_ISSUER || !env.AMO_JWT_SECRET) fail('Set Actions secrets AMO_JWT_ISSUER and AMO_JWT_SECRET for the PVT AMO owner');
  return { issuer: env.AMO_JWT_ISSUER, secret: env.AMO_JWT_SECRET };
}

export function authorization(config, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: config.issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `JWT ${message}.${createHmac('sha256', config.secret).update(message).digest('base64url')}`;
}

// AMO signs the XPI after upload, changing file.hash. Keep the original release
// and reviewer-source digests in private reviewer notes to identify safe retries.
export function releaseProof(archive, source) {
  return `PVT release archive SHA-256: ${digest(archive)}; PVT reviewer source SHA-256: ${digest(source)}`;
}

// AMO limits approval_notes to 3000 characters. Keep full instructions in
// the reviewer ZIP and always retain both digests in the API summary.
export function reviewerNotes(approvalNotes, archive, source) {
  const proof = releaseProof(archive, source);
  // FormData converts line endings to CRLF. Budget the exact transmitted text.
  const normalize = text => text.replace(/\r\n|\r|\n/g, '\r\n');
  const text = normalize(approvalNotes);
  const reference = '\r\n\r\nFull build instructions are in REVIEWER_NOTES.md in the attached source ZIP.';
  const room = 3000 - proof.length - reference.length - 4;
  const summary = text.length > room ? text.slice(0, room).replace(/\r$/, '') + reference : text;
  return `${summary}\r\n\r\n${proof}`.trim();
}

export async function firefoxRelease({ config, name, guid, version, archive, source, notes = '', approvalNotes = '', statusOnly = false, fetcher = fetch, wait = pause }) {
  if (!config.issuer || !config.secret || !['pvt-rc', 'pvt-rd'].includes(name) || guid !== `${name}@gnaservicesinc.com` || !/^\d+\.\d+\.\d+$/.test(version || '')) fail('Invalid Firefox release configuration');
  const addon = `${origin}/addons/addon/${encodeURIComponent(guid)}`;
  const request = async (url, method = 'GET', body, type, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        // Each retry needs a fresh short-lived JWT after the server's delay.
        return await requestJson(fetcher, url, { method, body, headers: { Authorization: authorization(config), ...(type ? { 'Content-Type': type } : {}) } }, options);
      } catch (error) {
        // A 429 is an explicit refusal, so replaying this request cannot create
        // a duplicate version. Ambiguous timeouts are never replayed here.
        if (!error.retryMs || error.retryMs > 600000 || attempt >= 4) throw error;
        console.error(`Firefox AMO rate limit: waiting ${Math.ceil(error.retryMs / 1000) + 1} seconds before retry`);
        await wait(error.retryMs + 1000);
      }
    }
  };
  const identity = await request(`${addon}/`);
  if (identity.guid !== guid) fail('AMO returned a different add-on identity');
  let current = await request(`${addon}/versions/v${version}/`, 'GET', undefined, undefined, { allow404: true });
  if (statusOnly) return { store: 'firefox', guid, version, versionId: current?.id || null, state: current?.file?.status || 'not-submitted', channel: current?.channel || null, reviewerSourceAttached: Boolean(current?.source) };
  if (!archive?.length || !source?.length) fail('Firefox release and reviewer source archives must not be empty');
  const proof = releaseProof(archive, source);
  const approval = reviewerNotes(approvalNotes, archive, source);
  const alreadySubmitted = Boolean(current);
  if (current) {
    if (!Number.isSafeInteger(current.id) || current.version !== version || current.channel !== 'listed' || !current.approval_notes?.includes(proof)) fail('Existing AMO version does not have matching release/source digests in reviewer notes; inspect AMO before retrying');
    if (!['unreviewed', 'public'].includes(current.file?.status) || current.is_disabled) fail('Existing AMO version is disabled or rejected; inspect AMO before retrying');
    if (!current.source) {
      const form = new FormData(); form.set('source', new Blob([source], { type: 'application/zip' }), `${name}-${version}-firefox-source.zip`);
      current = await request(`${addon}/versions/${current.id}/`, 'PATCH', form);
    }
  } else {
    const form = new FormData();
    form.set('upload', new Blob([archive], { type: 'application/x-xpinstall' }), `${name}-${version}-firefox.xpi`);
    form.set('channel', 'listed');
    let upload = await request(`${origin}/addons/upload/`, 'POST', form);
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(upload.uuid || '')) fail('AMO returned an invalid upload identity');
    const uuid = upload.uuid;
    for (let attempt = 0; !upload.processed && attempt < 90; attempt++) {
      await wait(10000);
      upload = await request(`${origin}/addons/upload/${uuid}/`);
      if (upload.uuid !== uuid) fail('AMO returned a different upload identity');
    }
    if (!upload.processed || !upload.valid || upload.channel !== 'listed' || upload.version !== version || upload.submitted) fail('AMO upload validation failed or is incomplete; this run did not submit a new version');
    const create = new FormData();
    create.set('upload', uuid);
    create.set('source', new Blob([source], { type: 'application/zip' }), `${name}-${version}-firefox-source.zip`);
    create.set('license', 'GPL-3.0-only');
    create.set('approval_notes', approval);
    current = await request(`${addon}/versions/`, 'POST', create);
  }
  if (!Number.isSafeInteger(current.id) || current.version !== version || current.channel !== 'listed' || !current.approval_notes?.includes(proof) || !current.source) {
    fail('AMO version or reviewer source confirmation differs from the release; inspect AMO before retrying');
  }
  if (notes || approvalNotes) {
    const update = { ...(notes ? { release_notes: { 'en-US': notes } } : {}), approval_notes: approval };
    await request(`${addon}/versions/${current.id}/`, 'PATCH', JSON.stringify(update), 'application/json');
  }
  const confirmation = await request(`${addon}/versions/${current.id}/`);
  if (confirmation.version !== version || confirmation.channel !== 'listed' || !confirmation.approval_notes?.includes(proof) || !confirmation.source || !['unreviewed', 'public'].includes(confirmation.file?.status) || confirmation.is_disabled) {
    fail('AMO submission confirmation is incomplete; inspect AMO before retrying');
  }
  return { store: 'firefox', guid, version, versionId: confirmation.id, state: confirmation.file.status, channel: confirmation.channel, reviewerSourceAttached: true, alreadySubmitted };
}

if (isMain(import.meta.url)) {
  try {
    const mode = cliMode();
    const sourceRoot = process.env.SOURCE_DIR ? resolve(process.env.SOURCE_DIR) : root;
    const release = await metadata(sourceRoot);
    const { name, guid, version } = release;
    const archiveDir = process.env.RELEASE_DIR ? resolve(process.env.RELEASE_DIR) : resolve(root, 'release');
    const checksums = resolve(archiveDir, 'SHA256SUMS.txt');
    let archive, source;
    if (mode !== '--status') {
      archive = await verifiedArchive(resolve(archiveDir, `${name}-${version}-firefox.zip`), release, checksums);
      source = await verifiedSource(resolve(archiveDir, `${name}-${version}-firefox-source.zip`), release, checksums);
    }
    if (mode === '--dry-run') report({ store: 'firefox', version, guid, archiveVerified: true, reviewerSourceVerified: true, action: 'dry-run; no requests made' });
    else {
      const config = configuration();
      if (mode === '--preflight') report({ store: 'firefox', version, guid, archiveVerified: true, reviewerSourceVerified: true, credentialsConfigured: true, action: 'preflight; no requests made' });
      else {
        const notes = mode === '--submit' ? await readFile(resolve(sourceRoot, 'RELEASE_NOTES.md'), 'utf8') : '';
        const approvalNotes = mode === '--submit' ? execFileSync('unzip', ['-p', resolve(archiveDir, `${name}-${version}-firefox-source.zip`), `${name}/REVIEWER_NOTES.md`], { encoding: 'utf8' }) : '';
        report(await firefoxRelease({ config, name, guid, version, archive, source, notes, approvalNotes, statusOnly: mode === '--status' }));
      }
    }
  } catch (error) { reportFailure(error); }
}
