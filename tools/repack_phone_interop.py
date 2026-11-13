"""Keep the user's native APK code while replacing the shared UI and version resources."""
from pathlib import Path
import sys
import zipfile

base, resources, output = map(Path, sys.argv[1:4])
web = Path(__file__).resolve().parents[1] / 'web'
with zipfile.ZipFile(base) as original, zipfile.ZipFile(resources) as compiled, zipfile.ZipFile(output, 'w') as target:
    for entry in original.infolist():
        name = entry.filename
        if name.startswith(('META-INF/', 'assets/web/')) or name in compiled.namelist():
            continue
        if name == 'classes3.dex' and len(sys.argv)>4:
            continue
        target.writestr(name, original.read(name), compress_type=entry.compress_type)
    for entry in compiled.infolist():
        if entry.filename.startswith('META-INF/'):
            continue
        method=zipfile.ZIP_STORED if entry.filename in ('AndroidManifest.xml','resources.arsc') else entry.compress_type
        target.writestr(entry.filename, compiled.read(entry), compress_type=method)
    for path in sorted(web.rglob('*')):
        if path.is_file():
            target.writestr('assets/web/' + path.relative_to(web).as_posix(), path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    if len(sys.argv)>4:
        target.writestr('classes3.dex',Path(sys.argv[4]).read_bytes(),compress_type=zipfile.ZIP_DEFLATED)
print('Preserved original native code; replaced UI and version resources')
