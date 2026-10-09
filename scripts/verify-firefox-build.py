"""Verify reviewer source rebuilds the exact Firefox files released on GitHub."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', nargs='?', default='.')
args = parser.parse_args()
source = Path(args.source)
pkg = json.loads((source / 'package.json').read_text())
root = source / 'dist/firefox'
expected = {file.relative_to(root).as_posix(): file.read_bytes() for file in root.rglob('*') if file.is_file()}
if not expected or 'manifest.json' not in expected:
    raise SystemExit('Missing rebuilt Firefox extension')
archive = source / 'release' / f"{pkg['name']}-{pkg['version']}-firefox.zip"
with ZipFile(archive) as zipped:
    names = [entry.filename for entry in zipped.infolist() if not entry.is_dir()]
    if len(names) != len(set(names)) or set(names) != set(expected):
        raise SystemExit('Released Firefox files differ from the reviewer-source build')
    if any(zipped.read(name) != data for name, data in expected.items()):
        raise SystemExit('Released Firefox content differs from the reviewer-source build')
print('Firefox reviewer-source build matches every released file')
