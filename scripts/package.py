"""Package browser builds, with manifest at ZIP root, and verify version."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
package = json.loads(Path('package.json').read_text())
output = Path('release'); output.mkdir(exist_ok=True)
checksums = []
for browser in ('chrome', 'firefox', 'safari'):
    root = Path('dist') / browser
    assert json.loads((root / 'manifest.json').read_text())['version'] == package['version']
    archive = output / f"{package['name']}-{package['version']}-{browser}.zip"
    with ZipFile(archive, 'w', ZIP_DEFLATED) as zipped:
        for file in sorted(root.rglob('*')):
            if file.is_file(): zipped.write(file, file.relative_to(root))
    with ZipFile(archive) as zipped:
        assert json.loads(zipped.read('manifest.json'))['version'] == package['version']
    checksums.append(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}")
(output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n')
