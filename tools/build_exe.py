# -*- coding: utf-8 -*-
"""把 onedir 版本打包成单个「一起看.exe」。

流程：
  1. PyInstaller --onedir 生成 dist/TogetherWatch
  2. 压成 dist/app.zip
  3. 用 .NET 的 csc 把 Launcher.cs + app.zip 编译成一个 exe
"""
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
ONEDIR = os.path.join(DIST, "TogetherWatch")
ZIP = os.path.join(DIST, "app.zip")
CSC = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
FINAL = os.path.join(DIST, "一起看.exe")


def make_zip():
    if not os.path.isdir(ONEDIR):
        print("找不到 %s，请先运行 PyInstaller" % ONEDIR)
        return False
    n = 0
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, _dirs, files in os.walk(ONEDIR):
            for f in files:
                p = os.path.join(root, f)
                if os.path.relpath(p,ONEDIR).replace('\\','/')=='_internal/relay-client.json':
                    continue
                z.write(p, os.path.relpath(p, ONEDIR))
                n += 1
        private_config=os.environ.get('WT_RELAY_CLIENT_CONFIG')
        if private_config:
            sys.path.insert(0,ROOT)
            from core.relay_config import load_builtin_relay
            config=load_builtin_relay(ROOT)
            if not config.get('pass'):raise ValueError('Restricted relay credentials missing')
            import json
            z.writestr('_internal/relay-client.json',json.dumps(config))
            n+=1
    print("已压缩 %d 个文件 -> app.zip (%.1f MB)" % (n, os.path.getsize(ZIP) / 1048576))
    return True


def compile_launcher():
    if not os.path.isfile(CSC):
        print("找不到 csc.exe：%s" % CSC)
        return False
    tmp_out = os.path.join(DIST, "TogetherWatch-launcher.exe")
    args = [
        CSC, "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", "/debug-",
        "/win32icon:" + os.path.join(ROOT, "app.ico"),
        "/resource:" + ZIP + ",app.zip",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.IO.Compression.dll",
        "/reference:System.IO.Compression.FileSystem.dll",
        "/reference:System.Web.Extensions.dll",
        "/out:" + tmp_out,
        os.path.join(ROOT, "src", "Launcher.cs"),
    ]
    print("编译启动器…")
    if subprocess.call(args) != 0:
        return False
    shutil.copyfile(tmp_out, FINAL)
    os.remove(tmp_out)
    print("完成：%s (%.1f MB)" % (FINAL, os.path.getsize(FINAL) / 1048576))
    return True


if __name__ == "__main__":
    if not make_zip():
        sys.exit(1)
    if not compile_launcher():
        sys.exit(1)
