"""1GB 超の転送向けレジューム用チェックポイント（ディスク上の JSON）。

失敗時はチェックポイントファイルを削除すれば「次回は最初から」に戻せる。
Google の resumable セッションは API でキャンセル可能（/api/engine/resume-checkpoints/.../cancel）。
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from ..config import repo_root

logger = logging.getLogger(__name__)

CHECKPOINT_VERSION = 1
CHECKPOINT_SUBDIR = "data/migration_resume"


def checkpoint_dir() -> Path:
    p = repo_root() / "desktop" / CHECKPOINT_SUBDIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def checkpoint_id_for_file(root_path_lower: str, path_lower: str, file_size: int) -> str:
    raw = f"{CHECKPOINT_VERSION}|{root_path_lower}|{path_lower}|{file_size}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def checkpoint_path(checkpoint_id: str) -> Path:
    return checkpoint_dir() / f"{checkpoint_id}.json"


def load_checkpoint(checkpoint_id: str) -> dict[str, Any] | None:
    path = checkpoint_path(checkpoint_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != CHECKPOINT_VERSION:
            return None
        return data
    except Exception:
        logger.exception("load_checkpoint failed path=%s", path)
        return None


def save_checkpoint_atomic(checkpoint_id: str, data: dict[str, Any]) -> None:
    path = checkpoint_path(checkpoint_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    payload = json.dumps(
        {**data, "version": CHECKPOINT_VERSION},
        ensure_ascii=False,
    )
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def delete_checkpoint(checkpoint_id: str) -> bool:
    path = checkpoint_path(checkpoint_id)
    if path.is_file():
        path.unlink()
        return True
    return False


def list_checkpoints_metadata() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    d = checkpoint_dir()
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("version") != CHECKPOINT_VERSION:
                continue
            cid = p.stem
            out.append(
                {
                    "checkpoint_id": cid,
                    "path_lower": data.get("path_lower"),
                    "file_size": data.get("file_size"),
                    "rel": data.get("rel"),
                    "gdrive_offset": data.get("gdrive_offset"),
                    "has_gdrive_location": bool(data.get("gdrive_location")),
                }
            )
        except Exception:
            logger.debug("skip checkpoint parse %s", p, exc_info=True)
    return out
