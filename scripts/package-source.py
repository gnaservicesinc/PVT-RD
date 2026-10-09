"""Create deterministic AMO reviewer source from the selected release checkout."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

REQUIRED = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE',
            'index.html', 'chrome-store.json', 'scripts/build.mjs', 'src/main.jsx',
            'src/background.js', 'vendor/pvt-remote-client/App.jsx',
            'vendor/pvt-remote-client/SOURCE.json', 'public/icons/icon-128.png')

def safe_path(name):
    parts = PurePosixPath(name).parts
    return (not name.startswith('/') and '\\' not in name and '..' not in parts
            and not any(re.fullmatch(r'(?:node_modules|dist|release|\.git|\.release-local|\.DS_Store|\.env(?:\..*)?)', part, re.I) for part in parts)
            and not re.search(r'\.(?:pem|key|zip|xpi|crx|tar\.gz)$', name, re.I))

def create_source(source, output):
    source = Path(source).resolve()
    output = Path(output).resolve()
    pkg = json.loads((source / 'package.json').read_text())
    if pkg['name'] not in ('pvt-rc', 'pvt-rd') or not re.fullmatch(r'\d+\.\d+\.\d+', pkg['version']) or pkg['license'] != 'GPL-3.0-only':
        raise ValueError('Invalid release identity, version, or license')
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Invalid source revision')
    # Build inputs are selected explicitly; tracked keys or environment files can
    # never enter the reviewer ZIP, even when accidentally present in Git.
    tracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z']).decode().split('\0')
    files = sorted(name for name in tracked if name and (name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'README.md', 'RELEASE_NOTES.md', 'index.html', 'chrome-store.json')
                   or name.startswith(('src/', 'vendor/', 'public/')) or name == 'scripts/build.mjs'))
    if not all(name in files for name in REQUIRED):
        raise ValueError('Reviewer source is missing build inputs')
    if not all(safe_path(name) and not (source / name).is_symlink() and (source / name).is_file() for name in files):
        raise ValueError('Reviewer source includes a private or unsafe file')
    notes = f'''# Firefox reviewer source

This archive contains the complete, unminified {pkg['name']} {pkg['version']} source
and pinned dependency lockfile from Git revision {revision}.

Build on Linux, macOS, or Windows using Node.js 22.13+ and the pnpm version pinned
in package.json. Run ./reviewer-build.sh (or the commands inside it).
The Firefox extension is generated in dist/firefox; manifest.json belongs at
its archive root. scripts/build.mjs also generates Chrome and Safari builds.
Dependencies are installed from the public npm registry using pnpm-lock.yaml.
No sibling PVT checkout, private server, credentials, or signing key is needed.
Vendor source is included under vendor/pvt-remote-client; SOURCE.json records
its upstream provenance. All project source is GPL-3.0-only; see LICENSE.

The extension pairs with a user-controlled Procedural Visualizer Tool host.
Open its toolbar action to launch the remote tab. Settings and disconnected UI
can be reviewed without PVT. Live control or display requires the desktop PVT
application, importing its .pvthost pairing file and importing the extension's
.pvtremote file in PVT Settings > Remotes. Keep both running on the same network.
The source build does not submit or publish anything to a browser store.
'''
    generated = {
        'SOURCE_REVISION.txt': (revision + '\n').encode(),
        'REVIEWER_NOTES.md': notes.encode(),
        'reviewer-build.sh': b'#!/usr/bin/env sh\nset -eu\ncd "$(dirname "$0")"\ncorepack enable\ncorepack pnpm install --frozen-lockfile\ncorepack pnpm build\n',
    }
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{pkg['name']}-{pkg['version']}-firefox-source.zip"
    contents = {name: (source / name).read_bytes() for name in files}
    contents.update(generated)
    with ZipFile(archive, 'w', compression=ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, data in sorted(contents.items()):
            info = ZipInfo(f"{pkg['name']}/{name}", date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = ZIP_DEFLATED
            info.external_attr = (0o100755 if name == 'reviewer-build.sh' else 0o100644) << 16
            zipped.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    manifest = output / 'SHA256SUMS.txt'
    lines = manifest.read_text().splitlines() if manifest.exists() else []
    lines = [line for line in lines if line[66:] != archive.name]
    lines.append(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}")
    manifest.write_text('\n'.join(lines) + '\n')
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default='.')
    parser.add_argument('--output', default='release')
    args = parser.parse_args()
    print(create_source(args.source, args.output).name)
