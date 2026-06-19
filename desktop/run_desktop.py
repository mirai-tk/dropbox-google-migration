#!/usr/bin/env python3
"""Launch FastAPI + pywebview (macOS desktop shell)."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

# Ensure `desktop/` is on path when run as script
_DESKTOP_ROOT = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_DESKTOP_ROOT)
if _DESKTOP_ROOT not in sys.path:
    sys.path.insert(0, _DESKTOP_ROOT)


def _resolve_venv_python(desktop_root: str) -> str | None:
    """desktop/.venv の Python 実行ファイルパス（無ければ None）。"""
    if sys.platform == "win32":
        cand = os.path.join(desktop_root, ".venv", "Scripts", "python.exe")
        return cand if os.path.isfile(cand) else None
    bindir = os.path.join(desktop_root, ".venv", "bin")
    for name in ("python", "python3"):
        cand = os.path.join(bindir, name)
        if os.path.isfile(cand):
            return cand
    return None


def _ensure_desktop_venv() -> None:
    """
    エディタの「ターミナルで実行」がシステム python になると keyring 等で落ちるため、
    desktop/.venv があれば同じ引数で venv の Python に付け替える。
    """
    try:
        import keyring  # noqa: F401
        return
    except ModuleNotFoundError:
        pass
    venv_py = _resolve_venv_python(_DESKTOP_ROOT)
    if venv_py:
        try:
            if os.path.realpath(sys.executable) != os.path.realpath(venv_py):
                script = os.path.abspath(__file__)
                os.execv(venv_py, [venv_py, script, *sys.argv[1:]])
        except OSError as e:
            print(f".venv の Python への再実行に失敗しました: {e}", file=sys.stderr)
    print(
        "依存パッケージが見つかりません（例: keyring）。desktop 用 venv を用意してください:\n"
        f"  cd {_DESKTOP_ROOT}\n"
        "  python3 -m venv .venv\n"
        "  .venv/bin/pip install -r requirements.txt\n"
        "  .venv/bin/python run_desktop.py",
        file=sys.stderr,
    )
    sys.exit(1)


def _check_pydantic_core_arch() -> None:
    """
    Rosetta(x86_64) の Python で arm64 用に入れた .venv を開くと pydantic_core で落ちる。
    長いトレースバックの前に原因と作り直し手順を出す。
    """
    try:
        import pydantic_core  # noqa: F401
    except ImportError as e:
        err = str(e).lower()
        if "incompatible architecture" not in err:
            raise
        print(
            "Python と .venv 内のバイナリ（pydantic_core 等）の CPU アーキテクチャが一致していません。\n"
            "多くの場合: .venv は Apple Silicon(arm64) 用なのに、今のターミナルが Rosetta で "
            "Intel(x86_64) の Python を動かしている、またはその逆です。\n\n"
            "対処（Apple Silicon では arm64 で venv を作り直すのが簡単）:\n"
            f"  cd {_DESKTOP_ROOT}\n"
            "  rm -rf .venv\n"
            "  # pyenv（例: pyenv local 3.12.6 済み）なら:\n"
            "  arch -arm64 \"$(pyenv which python)\" -m venv .venv\n"
            "  # pyenv 以外なら: arch -arm64 $(which python3) -m venv .venv\n"
            "  .venv/bin/pip install -r requirements.txt\n"
            "  # 以後は Rosetta ではないターミナルで: .venv/bin/python run_desktop.py\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _newest_mtime(paths: list[Path]) -> float:
    latest = 0.0
    for p in paths:
        if not p.exists():
            continue
        if p.is_file():
            latest = max(latest, p.stat().st_mtime)
            continue
        for f in p.rglob("*"):
            if f.is_file():
                latest = max(latest, f.stat().st_mtime)
    return latest


def _ensure_desktop_ui_built_for_dev() -> None:
    """--dev 時: source/src が dist より新しければ build:desktop する（UI は常に dist 配信）。"""
    source = Path(_REPO_ROOT) / "source"
    dist_index = source / "dist" / "index.html"
    src_dir = source / "src"
    src_mtime = _newest_mtime([src_dir, source / "index.html", source / "vite.config.js"])
    dist_mtime = dist_index.stat().st_mtime if dist_index.is_file() else 0.0
    if src_mtime <= dist_mtime:
        return
    if not (source / "node_modules").is_dir():
        print(
            "UI ソースが dist より新しいですが node_modules がありません。\n"
            "  make source-install && make source-build-desktop\n"
            "を実行してから再起動してください。",
            file=sys.stderr,
        )
        return
    print("UI ソースが dist より新しいため npm run build:desktop を実行します…", flush=True)
    subprocess.run(
        ["npm", "run", "build:desktop"],
        cwd=source,
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--dev",
        action="store_true",
        help=(
            "開発モード: DEBUG ログ + UI ソースが dist より新しければ build:desktop を自動実行"
            "（ウィンドウは FastAPI が配信する source/dist を表示。HMR は make source-dev-desktop）"
        ),
    )
    args = parser.parse_args()
    if args.dev:
        os.environ["PAPER_MIGRATOR_DEV"] = "1"
        _ensure_desktop_ui_built_for_dev()

    import app.config  # noqa: F401 — .env を先に読む（create_app 内で開発ログを初期化）

    _check_pydantic_core_arch()
    from app.server import create_app

    app = create_app()
    import uvicorn

    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
    )
    # メモリ API のアクセスログ抑制は app.server の lifespan で attach（uvicorn 起動後に有効）
    server = uvicorn.Server(config)

    def run_server() -> None:
        server.run()

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    # Wait until server accepts connections
    for _ in range(50):
        try:
            import httpx

            httpx.get(f"http://{args.host}:{args.port}/", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)
    else:
        print("Server failed to start", file=sys.stderr)
        sys.exit(1)

    import webview

    from app.desktop_api import DesktopApi

    webview.create_window(
        "Dropbox to Google Drive Migrator",
        f"http://{args.host}:{args.port}/",
        width=1280,
        height=900,
        js_api=DesktopApi(),
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    _ensure_desktop_venv()
    main()
