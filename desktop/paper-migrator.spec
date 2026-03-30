# -*- mode: python ; coding: utf-8 -*-
# Run from `desktop/`: pyinstaller paper-migrator.spec
# Requires: npm run build:desktop --prefix ../source
from pathlib import Path

block_cipher = None
desktop_root = Path(SPECPATH).resolve()
repo_root = desktop_root.parent
dist_ui = repo_root / "source" / "dist"

datas = []
if dist_ui.is_dir():
    datas.append((str(dist_ui), "static"))

a = Analysis(
    [str(desktop_root / "run_desktop.py")],
    pathex=[str(desktop_root)],
    binaries=[],
    datas=datas,
    hiddenimports=["webview", "keyring.backends.macOS", "psutil"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Dropbox to Google Drive Migrator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="Dropbox to Google Drive Migrator",
)
