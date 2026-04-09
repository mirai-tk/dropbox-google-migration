"""デスクトップアプリ全体のファイルログ（常時）と、開発時の DEBUG 詳細。"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import repo_root

_CONFIGURED = False
_MEMORY_POLL_ACCESS_FILTER_ATTACHED = False


class SuppressMemoryPollAccessLog(logging.Filter):
    """GET /api/app/memory の 200 を uvicorn アクセスログから除外（UI の定期ポーリング用）。"""

    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn は access_logger.info('%s...%d', ..., status) 形式のため、getMessage() は
        # `... "GET /path HTTP/1.1" 200` で終わり、画面の "200 OK" の前スペース付きとは一致しない。
        try:
            args = record.args
            if (
                args
                and len(args) >= 5
                and args[1] == "GET"
                and isinstance(args[2], str)
                and args[2].startswith("/api/app/memory")
                and int(args[4]) == 200
            ):
                return False
        except (TypeError, ValueError, AttributeError):
            pass
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "/api/app/memory" in msg and " 200" in msg:
            return False
        return True


def attach_uvicorn_memory_poll_suppressor() -> None:
    """
    uvicorn は起動時にロギングを組み直すため、run_desktop で付けた Filter が効かないことがある。
    lifespan 開始時に 1 回だけ付け直す。
    """
    global _MEMORY_POLL_ACCESS_FILTER_ATTACHED
    if _MEMORY_POLL_ACCESS_FILTER_ATTACHED:
        return
    logging.getLogger("uvicorn.access").addFilter(SuppressMemoryPollAccessLog())
    _MEMORY_POLL_ACCESS_FILTER_ATTACHED = True


def _maybe_archive_previous_latest(path: Path) -> None:
    """
    ファイル名が *_latest.log のとき、既存ファイルを log_YYYYMMDD_HHMMSS.log に退避する。
    （ログハンドラ追加前に呼ぶ。失敗しても起動は続行）
    """
    if not path.name.endswith("_latest.log"):
        return
    if not path.is_file():
        return
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = path.parent / f"log_{stamp}.log"
    n = 0
    while dest.exists():
        n += 1
        dest = path.parent / f"log_{stamp}_{n}.log"
    try:
        path.rename(dest)
    except OSError:
        pass


def is_dev_mode() -> bool:
    v = os.environ.get("PAPER_MIGRATOR_DEV", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def app_log_file_path() -> Path:
    """PAPER_MIGRATOR_LOG_FILE があればそのパス、なければ desktop/logs/app_latest.log"""
    custom = os.environ.get("PAPER_MIGRATOR_LOG_FILE", "").strip()
    if custom:
        return Path(custom).expanduser()
    return repo_root() / "desktop" / "logs" / "app_latest.log"


def configure_app_logging() -> None:
    """
    アプリ起動時に 1 回だけ、ローテーション付きファイルへログを出す。
    通常は INFO、PAPER_MIGRATOR_DEV=1（または run_desktop --dev）のときは DEBUG（エンジン詳細含む）。
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    path = app_log_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _maybe_archive_previous_latest(path)

    fh = RotatingFileHandler(
        path,
        maxBytes=5_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )

    root = logging.getLogger()
    root.addHandler(fh)

    dev = is_dev_mode()
    root.setLevel(logging.DEBUG if dev else logging.INFO)
    if dev:
        logging.getLogger("app.engine").setLevel(logging.DEBUG)
        logging.getLogger("app.engine.paper_docx").setLevel(logging.DEBUG)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    _CONFIGURED = True


# 後方互換名
configure_dev_logging = configure_app_logging
