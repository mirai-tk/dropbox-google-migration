"""長時間のサーバ処理向け: Google アクセストークンのリフレッシュと 401 再試行。"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

from .config import get_settings
from .migration_auth import MigrationAuthError

logger = logging.getLogger(__name__)

# Drive upload 等の一時障害（503 transientError 等）・レート制限
GDRIVE_TRANSIENT_HTTP_CODES = frozenset({408, 429, 500, 502, 503, 504})
GOOGLE_API_MAX_ATTEMPTS = 6


def _gdrive_http_is_transient(status: int) -> bool:
    return status in GDRIVE_TRANSIENT_HTTP_CODES


async def _drain_google_response(r: httpx.Response) -> None:
    """リトライ前にボディを読み切り、接続をプールに返す。"""
    try:
        await r.aread()
    except Exception:
        pass


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
    *,
    max_attempts: int = GOOGLE_API_MAX_ATTEMPTS,
) -> httpx.Response:
    """401 更新に加え、503/429 等と通信エラーを指数バックオフで再試行する。"""
    last_r: httpx.Response | None = None
    for attempt in range(max_attempts):
        try:
            r = await do(token_ref[0])
        except httpx.TransportError as e:
            if attempt >= max_attempts - 1:
                logger.error(
                    "Google API transport failed after %d attempts: %s",
                    max_attempts,
                    e,
                )
                raise
            delay = min(2.0 * (2**attempt), 60.0)
            logger.warning(
                "Google API transport error, retry %d/%d: %s",
                attempt + 1,
                max_attempts,
                e,
            )
            await asyncio.sleep(delay)
            continue

        if r.status_code == 401 and refresh and await refresh_google_access_token(
            client, token_ref, refresh
        ):
            await _drain_google_response(r)
            try:
                r = await do(token_ref[0])
            except httpx.TransportError as e:
                if attempt >= max_attempts - 1:
                    logger.error(
                        "Google API transport failed after token refresh: %s", e
                    )
                    raise
                delay = min(2.0 * (2**attempt), 60.0)
                logger.warning(
                    "Google API transport error after refresh, retry %d/%d: %s",
                    attempt + 1,
                    max_attempts,
                    e,
                )
                await asyncio.sleep(delay)
                continue

        if r.status_code == 401:
            raise MigrationAuthError(
                "Google の認証が無効です（アクセストークンの更新に失敗しました）。"
                " Google に再接続してから再度お試しください。"
            )
        if r.is_success or not _gdrive_http_is_transient(r.status_code):
            return r
        last_r = r
        await _drain_google_response(r)
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
            "Google API transient HTTP %s, retry %d/%d",
            r.status_code,
            attempt + 1,
            max_attempts,
        )
        await asyncio.sleep(delay)
    assert last_r is not None
    return last_r
