"""NDJSON streaming migration endpoint."""
import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .engine.migrate import run_folder_migration

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
    async def gen():
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

    return StreamingResponse(gen(), media_type="application/x-ndjson")
