"""長時間のサーバ処理向け: Google アクセストークンのリフレッシュと 401 再試行。"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import httpx

from .config import get_settings
from .migration_auth import MigrationAuthError

logger = logging.getLogger(__name__)


async def refresh_google_access_token(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh_token: str,
) -> bool:
    """token_ref[0] をリフレッシュトークンで更新。成功したら True。"""
    s = get_settings()
    cid = s.get("google_client_id") or ""
    sec = s.get("google_client_secret") or ""
    if not cid or not sec or not refresh_token:
        return False
    r = await client.post(
        "https://oauth2.googleapis.com/token",
        data={
            "refresh_token": refresh_token,
            "client_id": cid,
            "client_secret": sec,
            "grant_type": "refresh_token",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    if not r.is_success:
        logger.warning(
            "Google token refresh failed: %s %s",
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
    logger.info("Google access token refreshed")
    return True


async def google_request_with_token_refresh(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    do: Callable[[str], Awaitable[httpx.Response]],
) -> httpx.Response:
    """401 のときリフレッシュして 1 回だけ再試行（refresh がある場合）。"""
    r = await do(token_ref[0])
    if r.status_code == 401 and refresh and await refresh_google_access_token(
        client, token_ref, refresh
    ):
        r = await do(token_ref[0])
    if r.status_code == 401:
        raise MigrationAuthError(
            "Google の認証が無効です（アクセストークンの更新に失敗しました）。"
            " Google に再接続してから再度お試しください。"
        )
    return r
