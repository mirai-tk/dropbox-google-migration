#!/usr/bin/env python3
"""Launch FastAPI + pywebview (macOS desktop shell)."""
from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time

# Ensure `desktop/` is on path when run as script
_DESKTOP_ROOT = os.path.dirname(os.path.abspath(__file__))
if _DESKTOP_ROOT not in sys.path:
    sys.path.insert(0, _DESKTOP_ROOT)


class _SuppressMemoryPollAccessLog(logging.Filter):
    """ポーリング用 GET /api/app/memory の 200 を uvicorn アクセスログから除外する。"""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "/api/app/memory" in msg and " 200 " in msg:
            return False
        return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="開発モード: アプリログを DEBUG 詳細に（PAPER_MIGRATOR_DEV と同じ。既定の出力先は desktop/logs/app.log）",
    )
    args = parser.parse_args()
    if args.dev:
        os.environ["PAPER_MIGRATOR_DEV"] = "1"

    import app.config  # noqa: F401 — .env を先に読む（create_app 内で開発ログを初期化）

    from app.server import create_app

    app = create_app()
    import uvicorn

    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
    )
    logging.getLogger("uvicorn.access").addFilter(_SuppressMemoryPollAccessLog())
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
    )
    webview.start()


if __name__ == "__main__":
    main()
