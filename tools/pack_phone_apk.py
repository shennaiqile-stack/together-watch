"""Merge the compiled dex into the linked APK without breaking STORED alignment."""
import struct
import sys
import zipfile
from pathlib import Path

source, dex, output = map(Path, sys.argv[1:4])
with zipfile.ZipFile(source) as original, zipfile.ZipFile(output, 'w') as target:
    def write(name, data, method):
        info = zipfile.ZipInfo(name)
        info.compress_type = method
        if method == zipfile.ZIP_STORED:
            pad = (-(target.fp.tell() + 30 + len(name.encode('utf-8')))) % 4
            if pad:
                info.extra = struct.pack('<HH', 0xffff, pad) + b'\0' * pad
        target.writestr(info, data)

    for entry in original.infolist():
        if entry.filename == 'classes.dex':
            continue
        write(entry.filename, original.read(entry.filename), entry.compress_type)
    write('classes.dex', dex.read_bytes(), zipfile.ZIP_STORED)
print('Packed dex and kept compression modes')
