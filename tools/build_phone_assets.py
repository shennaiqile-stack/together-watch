"""Asset-only update from a verified previous APK; native code is kept byte-for-byte."""
import argparse
import struct
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description='在已签名的旧 APK 上替换网页资源并改版本号，原生代码保持不变')
parser.add_argument('--base', required=True, help='上一个已签名 APK')
parser.add_argument('--out', required=True, help='输出的未签名 APK')
parser.add_argument('--version-code', type=int, required=True)
parser.add_argument('--version-name', required=True)
parser.add_argument('--dex', help='可选，替换 classes3.dex')
args = parser.parse_args()

base, output = Path(args.base), Path(args.out)
root = Path(__file__).resolve().parents[1]
with zipfile.ZipFile(base) as original:
    manifest = bytearray(original.read('AndroidManifest.xml'))
    strings = []
    positions = []
    utf8 = False
    offset = 8
    while offset < len(manifest):
        kind, header, size = struct.unpack_from('<HHI', manifest, offset)
        if kind == 1:
            count, _, flags, start, _ = struct.unpack_from('<IIIII', manifest, offset + 8)
            utf8 = bool(flags & 256)

            def length(p, wide=False):
                if wide:
                    n = struct.unpack_from('<H', manifest, p)[0]
                    p += 2
                    if n & 0x8000:
                        n = ((n & 0x7fff) << 16) | struct.unpack_from('<H', manifest, p)[0]
                        p += 2
                else:
                    n = manifest[p]
                    p += 1
                    if n & 128:
                        n = ((n & 127) << 8) | manifest[p]
                        p += 1
                return n, p

            for i in range(count):
                p = offset + start + struct.unpack_from('<I', manifest, offset + header + 4 * i)[0]
                n, p = length(p, not utf8)
                if utf8:
                    n, p = length(p)
                count_bytes = n if utf8 else n * 2
                strings.append(bytes(manifest[p:p + count_bytes]).decode('utf-8' if utf8 else 'utf-16le'))
                positions.append((p, count_bytes))
        offset += size
    found = set()
    offset = 8
    while offset < len(manifest):
        kind, header, size = struct.unpack_from('<HHI', manifest, offset)
        if kind == 0x102:
            attr_start, attr_size, count = struct.unpack_from('<HHH', manifest, offset + 24)
            for i in range(count):
                p = offset + 16 + attr_start + i * attr_size
                name = strings[struct.unpack_from('<I', manifest, p + 4)[0]]
                if name == 'versionCode':
                    struct.pack_into('<I', manifest, p + 16, args.version_code)
                    found.add(name)
                if name == 'versionName':
                    index = struct.unpack_from('<I', manifest, p + 16)[0]
                    start, length_bytes = positions[index]
                    replacement = args.version_name.encode('utf-8' if utf8 else 'utf-16le')
                    assert len(replacement) == length_bytes, '版本号长度必须与旧版本一致'
                    manifest[start:start + length_bytes] = replacement
                    found.add(name)
        offset += size
    assert found == {'versionCode', 'versionName'}, '清单里没找到版本字段'
    with zipfile.ZipFile(output, 'w') as target:
        def write(name, data, method):
            info = zipfile.ZipInfo(name)
            info.compress_type = method
            if method == zipfile.ZIP_STORED:
                pad = (-(target.fp.tell() + 30 + len(name.encode('utf-8')))) % 4
                if pad:
                    info.extra = struct.pack('<HH', 0xffff, pad) + b'\0' * pad
            target.writestr(info, data)

        for entry in original.infolist():
            if entry.filename.startswith(('META-INF/', 'assets/web/')):
                continue
            if entry.filename == 'classes3.dex' and args.dex:
                continue
            data = bytes(manifest) if entry.filename == 'AndroidManifest.xml' else original.read(entry.filename)
            write(entry.filename, data, entry.compress_type)
        if args.dex:
            write('classes3.dex', Path(args.dex).read_bytes(), zipfile.ZIP_DEFLATED)
        for path in sorted((root / 'web').rglob('*')):
            if path.is_file():
                write('assets/web/' + path.relative_to(root / 'web').as_posix(), path.read_bytes(), zipfile.ZIP_DEFLATED)
print('Updated assets and version; preserved original native implementation')
