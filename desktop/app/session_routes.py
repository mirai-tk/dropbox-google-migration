"""Sync OAuth tokens (Keychain) and UI settings (JSON file)."""
from fastapi import APIRouter
from pydantic import BaseModel

from . import storage, user_settings

router = APIRouter(prefix="/api/session", tags=["session"])


class SessionSyncBody(BaseModel):
    google_access: str | None = None
    google_refresh: str | None = None
    dropbox_access: str | None = None
    dropbox_refresh: str | None = None
    dropbox_ns_id: str | None = None


class SettingsSyncBody(BaseModel):
    dropbox_current_path: str | None = None
    gdrive_browser_path: str | None = None
    gdrive_selected_folder_id: str | None = None


@router.post("/sync")
async def sync_session(body: SessionSyncBody):
    storage.save_tokens(
        google_access=body.google_access,
        google_refresh=body.google_refresh,
        dropbox_access=body.dropbox_access,
        dropbox_refresh=body.dropbox_refresh,
        dropbox_ns_id=body.dropbox_ns_id,
    )
    return {"ok": True}


@router.get("/settings")
async def get_settings():
    return user_settings.load_settings()


@router.post("/settings/sync")
async def sync_settings(body: SettingsSyncBody):
    user_settings.save_settings_merge(
        dropbox_current_path=body.dropbox_current_path,
        gdrive_browser_path=body.gdrive_browser_path,
        gdrive_selected_folder_id=body.gdrive_selected_folder_id,
    )
    return {"ok": True}


@router.get("/tokens")
async def get_tokens():
    return storage.load_all()


@router.post("/clear")
async def clear_session():
    storage.clear()
    user_settings.clear_all()
    return {"ok": True}


@router.post("/clear-google")
async def clear_google_session():
    storage.clear_google_keys()
    return {"ok": True}


@router.post("/clear-dropbox")
async def clear_dropbox_session():
    storage.clear_dropbox_keys()
    return {"ok": True}
