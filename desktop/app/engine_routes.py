"""NDJSON streaming migration endpoint."""
import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .engine.migrate import gdrive_resumable_cancel, run_folder_migration
from .engine.resume_checkpoint import (
    delete_checkpoint,
    list_checkpoints_metadata,
    load_checkpoint,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/engine", tags=["engine"])


class MigrateBody(BaseModel):
    root_path: str
    root_folder_name: str
    selected_folder_id: str
    dropbox_token: str
    dropbox_ns_id: str | None = None
    dropbox_refresh_token: str | None = None
    google_token: str
    google_refresh_token: str | None = None
    migration_id: str | None = None


@router.post("/migrate")
async def migrate_folder(body: MigrateBody):
    mid = body.migration_id or "migrate-py"

    async def gen():
        try:
            async for ev in run_folder_migration(
                root_path=body.root_path,
                root_folder_name=body.root_folder_name,
                selected_folder_id=body.selected_folder_id,
                dropbox_token=body.dropbox_token,
                dropbox_ns_id=body.dropbox_ns_id,
                dropbox_refresh_token=body.dropbox_refresh_token,
                google_token=body.google_token,
                google_refresh_token=body.google_refresh_token,
                migration_id=body.migration_id,
            ):
                line = json.dumps(ev, ensure_ascii=False) + "\n"
                yield line.encode("utf-8")
        except Exception as e:
            # 未捕捉だとストリームが途中で切れ Web 側は "Load failed" だけになる
            logger.exception("migrate NDJSON stream failed")
            err_ev: dict[str, Any] = {
                "type": "log",
                "id": mid,
                "message": f"移行エラー（サーバ）: {e}",
                "level": "error",
            }
            yield (json.dumps(err_ev, ensure_ascii=False) + "\n").encode("utf-8")

    return StreamingResponse(gen(), media_type="application/x-ndjson")


class ResumeCancelBody(BaseModel):
    """チェックポイント破棄。Google の未完了セッションを閉じるには google_token が必要。"""

    google_token: str | None = None
    google_refresh_token: str | None = None
    cancel_gdrive_session: bool = True


@router.get("/resume-checkpoints")
async def list_resume_checkpoints():
    """1GB+ 用レジュームチェックポイント一覧（メタのみ。ロールバック確認用）。"""
    return {"checkpoints": list_checkpoints_metadata()}


@router.post("/resume-checkpoints/{checkpoint_id}/cancel")
async def cancel_resume_checkpoint(checkpoint_id: str, body: ResumeCancelBody):
    """チェックポイント JSON を削除。cancel_gdrive_session 時は Google の resumable URL を DELETE。

    トークン無しで cancel_gdrive_session だけ True の場合は 400。
    cancel_gdrive_session False なら JSON のみ削除（次回転送は最初から）。
    """
    cp = load_checkpoint(checkpoint_id)
    if not cp:
        delete_checkpoint(checkpoint_id)
        return {"ok": True, "removed": False}

    loc = cp.get("gdrive_location")
    if body.cancel_gdrive_session and loc:
        if not body.google_token:
            raise HTTPException(
                status_code=400,
                detail="cancel_gdrive_session には google_token が必要です",
            )
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=120.0, read=None, write=120.0, pool=120.0)
        ) as client:
            token_ref: list[str] = [body.google_token]
            await gdrive_resumable_cancel(
                client,
                token_ref,
                body.google_refresh_token,
                loc,
            )

    delete_checkpoint(checkpoint_id)
    return {"ok": True, "removed": True}
