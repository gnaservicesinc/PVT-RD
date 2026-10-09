import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export class ReleaseError extends Error {}
export const fail = message => { throw new ReleaseError(message); };
export const digest = data => createHash('sha256').update(data).digest('hex');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const isMain = url => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
const execute = promisify(execFile);

export async function metadata(sourceRoot = root) {
  let pkg;
  try { pkg = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8')); }
  catch { fail('Cannot read the release package metadata'); }
  if (!['pvt-rc', 'pvt-rd'].includes(pkg.name) || !/^\d+\.\d+\.\d+$/.test(pkg.version || '') || pkg.license !== 'GPL-3.0-only') fail('Invalid PVT release identity, version, or license');
  const current = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== current.name) fail('Release belongs to a different PVT extension');
  return { name: pkg.name, version: pkg.version, guid: `${pkg.name}@gnaservicesinc.com` };
}

export function cliMode(args = process.argv.slice(2)) {
  const modes = ['--submit', '--status', '--preflight', '--dry-run'];
  if (args.length !== 1 || !modes.includes(args[0])) fail(`Choose exactly one of ${modes.join(', ')}`);
  return args[0];
}

export async function requestJson(fetcher, url, init, { allow404 = false } = {}) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120000) }); }
  catch { fail('Firefox AMO request failed or timed out; check the store dashboard before retrying'); }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) fail(`Firefox AMO failed (HTTP ${response.status}); check credentials, store metadata, and the dashboard`);
  try { return await response.json(); }
  catch { fail('Firefox AMO returned invalid JSON; check the dashboard before retrying'); }
}

export async function verifiedFile(path, checksumsPath) {
  let archive, lines;
  try {
    archive = await readFile(path);
    lines = (await readFile(checksumsPath, 'utf8')).split('\n');
  } catch { fail('Missing release archive or checksum manifest'); }
  const matches = lines.filter(line => /^[a-f0-9]{64}  [^/\\]+$/.test(line) && line.slice(66) === basename(path));
  if (matches.length !== 1 || digest(archive) !== matches[0].slice(0, 64)) fail('Release archive checksum differs from the release manifest');
  return archive;
}

export async function verifiedArchive(path, release, checksumsPath) {
  const archive = await verifiedFile(path, checksumsPath);
  let manifest;
  try { manifest = JSON.parse((await execute('unzip', ['-p', path, 'manifest.json'], { maxBuffer: 1024 * 1024 })).stdout); }
  catch { fail('Firefox release archive must contain manifest.json at its root'); }
  if (manifest.version !== release.version || manifest.manifest_version !== 3 || manifest.browser_specific_settings?.gecko?.id !== release.guid) fail('Firefox archive version, manifest format, or add-on ID differs from the release');
  return archive;
}

export async function verifiedSource(path, release, checksumsPath) {
  const archive = await verifiedFile(path, checksumsPath);
  let entries, pkg, revision;
  const prefix = `${release.name}/`;
  try {
    entries = (await execute('unzip', ['-Z1', path], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split('\n');
    pkg = JSON.parse((await execute('unzip', ['-p', path, `${prefix}package.json`])).stdout);
    revision = (await execute('unzip', ['-p', path, `${prefix}SOURCE_REVISION.txt`])).stdout.trim();
  } catch { fail('Cannot inspect the Firefox reviewer source ZIP'); }
  if (pkg.name !== release.name || pkg.version !== release.version || pkg.license !== 'GPL-3.0-only' || !/^[a-f0-9]{40}$/.test(revision)) fail('Firefox reviewer source identity or revision differs from the release');
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'index.html', 'chrome-store.json', 'REVIEWER_NOTES.md', 'reviewer-build.sh', 'scripts/build.mjs', 'src/main.jsx', 'src/background.js', 'vendor/pvt-remote-client/App.jsx', 'vendor/pvt-remote-client/SOURCE.json', 'public/icons/icon-128.png']) {
    if (!entries.includes(`${prefix}${file}`)) fail(`Firefox reviewer source ZIP is missing ${file}`);
  }
  if (new Set(entries).size !== entries.length || entries.some(file => !file.startsWith(prefix) || /(^|\/)(node_modules|dist|release|\.git|\.release-local|\.DS_Store|\.env(?:\..*)?)(\/|$)/i.test(file) || /\.(?:pem|key|zip|xpi|crx|tar\.gz)$/i.test(file) || file.includes('\\') || file.split('/').includes('..'))) fail('Firefox reviewer source ZIP includes generated, private, duplicate, or unsafe files');
  return archive;
}

export function report(result) { console.log(JSON.stringify(result)); }
export function reportFailure(error) {
  // Native errors and HTTP bodies can contain secrets; print only our errors.
  console.error(error instanceof ReleaseError ? error.message : 'Release operation failed; check configuration and the store dashboard');
  process.exitCode = 1;
}
