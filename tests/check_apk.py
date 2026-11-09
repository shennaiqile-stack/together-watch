"""Validate the final signed APK, including Android 11 resource-table constraints."""
import struct
import sys
import zipfile
from pathlib import Path


def check(apk):
    with zipfile.ZipFile(apk) as archive, apk.open("rb") as raw:
        resources = archive.getinfo("resources.arsc")
        assert resources.compress_type == zipfile.ZIP_STORED, "resources.arsc must be STORED"
        assert archive.testzip() is None, "corrupt ZIP entry"
        for entry in archive.infolist():
            assert "\\" not in entry.filename, f"invalid path: {entry.filename}"
            raw.seek(entry.header_offset)
            header = raw.read(30)
            assert header[:4] == b"PK\x03\x04", "invalid local header"
            local_method = struct.unpack_from("<H", header, 8)[0]
            assert local_method == entry.compress_type, "compression header mismatch"
            name_length, extra_length = struct.unpack_from("<HH", header, 26)
            offset = entry.header_offset + 30 + name_length + extra_length
            if entry.compress_type == zipfile.ZIP_STORED and not entry.is_dir():
                assert offset % 4 == 0, f"unaligned uncompressed entry: {entry.filename}"
            if entry.filename == "resources.arsc":
                print(f"PASS: resources.arsc STORED, byte offset {offset}, aligned to 4 bytes")
        for required in ("AndroidManifest.xml", "classes.dex", "assets/web/js/app.js"):
            archive.getinfo(required)
        print("PASS: ZIP integrity, local headers, resource table, alignment, entry paths")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
