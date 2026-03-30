"""長時間マイグレーション向け: Dropbox アクセストークンのリフレッシュと 401 再試行。"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import httpx

from .config import get_settings
from .migration_auth import MigrationAuthError

logger = logging.getLogger(__name__)


async def refresh_dropbox_access_token(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh_token: str,
) -> bool:
    """token_ref[0] を refresh で更新。デスクトップは client_secret 付き（/api/dropbox/refresh と同じ）。"""
    s = get_settings()
    key = s.get("dropbox_app_key") or ""
    secret = s.get("dropbox_app_secret") or ""
    if not key or not secret or not refresh_token:
        return False
    r = await client.post(
        "https://api.dropbox.com/oauth2/token",
        data={
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
            "client_id": key,
            "client_secret": secret,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    if not r.is_success:
        logger.warning(
            "Dropbox token refresh failed: %s %s",
            r.status_code,
            (r.text or "")[:500],
        )
        return False
    try:
        data = r.json()
    except Exception:
        return False
    at = data.get("access_token")
    if not at:
        return False
    token_ref[0] = at
    logger.info("Dropbox access token refreshed (migrate)")
    return True


async def dropbox_request_with_token_refresh(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    do: Callable[[str], Awaitable[httpx.Response]],
) -> httpx.Response:
    r = await do(token_ref[0])
    if r.status_code == 401 and refresh and await refresh_dropbox_access_token(
        client, token_ref, refresh
    ):
        r = await do(token_ref[0])
    if r.status_code == 401:
        raise MigrationAuthError(
            "Dropbox の認証が無効です（アクセストークンの更新に失敗しました）。"
            " Dropbox に再接続してから再度お試しください。"
        )
    return r
