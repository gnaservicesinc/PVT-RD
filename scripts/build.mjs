import {build as vite} from 'vite';
import {build as bundle} from 'esbuild';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const icons = Object.fromEntries([16, 32, 48, 64, 128, 256, 512].map(size => [size, `icons/icon-${size}.png`]));
const store = JSON.parse(await readFile(new URL('../chrome-store.json', import.meta.url)));
if (!/^[a-p]{32}$/.test(store.itemId)) throw Error('Invalid Chrome Web Store item ID');
const role = pkg.name.endsWith('rd') ? 'Display' : 'Control';
for (const browser of ['chrome', 'firefox', 'safari']) {
  const outDir = `dist/${browser}`;
  await vite({base: './', build: {outDir, emptyOutDir: true, target: 'es2022', sourcemap: false}});
  await bundle({entryPoints: ['src/background.js'], outfile: `${outDir}/background.js`, bundle: true, format: 'iife', target: 'es2022'});
  const manifest = {
    homepage_url: store.url,
    manifest_version: 3, name: `PVT Remote ${role}`, version: pkg.version,
    description: `Paired remote ${role.toLowerCase()} for Procedural Visualizer Tool.`,
    icons, permissions: ['storage'], action: {default_title: `Open PVT Remote ${role}`, default_icon: icons},
    background: browser === 'chrome' ? {service_worker: 'background.js'} : {scripts: ['background.js']},
    content_security_policy: {extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' ws: wss:; media-src 'self' blob:;"},
  };
  if (browser === 'chrome') manifest.minimum_chrome_version = '137';
  if (browser === 'firefox') manifest.browser_specific_settings = {gecko: {id: `${pkg.name}@gnaservicesinc.com`, strict_min_version: '140.0', data_collection_permissions: {required: ['none']}}};
  await mkdir(outDir, {recursive: true});
  await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}
