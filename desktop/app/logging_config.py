"""開発モード時のみファイルへ詳細ログ（マイグレーション／Paper 調査用）。"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import repo_root

_CONFIGURED = False


def is_dev_mode() -> bool:
    v = os.environ.get("PAPER_MIGRATOR_DEV", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def dev_log_file_path() -> Path:
    """PAPER_MIGRATOR_LOG_FILE があればそのパス、なければ desktop/logs/migration-debug.log"""
    custom = os.environ.get("PAPER_MIGRATOR_LOG_FILE", "").strip()
    if custom:
        return Path(custom).expanduser()
    return repo_root() / "desktop" / "logs" / "migration-debug.log"


def configure_dev_logging() -> None:
    """PAPER_MIGRATOR_DEV=1（または run_desktop --dev）のときだけローテーション付きファイルハンドラを付与。"""
    global _CONFIGURED
    if not is_dev_mode() or _CONFIGURED:
        return
    path = dev_log_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)

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
    root.setLevel(logging.DEBUG)
    root.addHandler(fh)
    # 子ロガー app.engine の DEBUG が root の WARNING で弾かれないようにする
    logging.getLogger("app.engine").setLevel(logging.DEBUG)
    logging.getLogger("app.engine.paper_docx").setLevel(logging.DEBUG)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    _CONFIGURED = True
