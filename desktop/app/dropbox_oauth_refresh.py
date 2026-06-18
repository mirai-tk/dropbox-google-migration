"""長時間マイグレーション向け: Dropbox アクセストークンのリフレッシュと 401 再試行。"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

from .config import get_settings
from .migration_auth import MigrationAuthError

logger = logging.getLogger(__name__)

# レート制限・一時障害（503 Service Unavailable 等）
DROPBOX_TRANSIENT_HTTP_CODES = frozenset({408, 429, 500, 502, 503, 504})
DROPBOX_API_MAX_ATTEMPTS = 6


def _dropbox_http_is_transient(status: int) -> bool:
    return status in DROPBOX_TRANSIENT_HTTP_CODES


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
    *,
    max_attempts: int = DROPBOX_API_MAX_ATTEMPTS,
) -> httpx.Response:
    last_r: httpx.Response | None = None
    for attempt in range(max_attempts):
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
        if r.is_success or not _dropbox_http_is_transient(r.status_code):
            return r
        last_r = r
        if attempt >= max_attempts - 1:
            break
        delay = min(2.0 * (2**attempt), 60.0)
        retry_after = r.headers.get("Retry-After")
        if retry_after:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                pass
        logger.warning(
            "Dropbox API transient HTTP %s, retry %d/%d",
            r.status_code,
            attempt + 1,
            max_attempts,
        )
        await asyncio.sleep(delay)
    assert last_r is not None
    return last_r
