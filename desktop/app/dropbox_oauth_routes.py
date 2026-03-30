"""Dropbox OAuth: PKCE on server + system browser (avoids WebView login hang on macOS)."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
import webbrowser
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from . import storage
from .config import get_settings

router = APIRouter(prefix="/api/oauth/dropbox", tags=["oauth-dropbox"])

_pending: dict[str, dict] = {}
PENDING_TTL = 600.0


def _cleanup() -> None:
    now = time.time()
    dead = [k for k, v in _pending.items() if now - v["created"] > PENDING_TTL]
    for k in dead:
        _pending.pop(k, None)


def _pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode("ascii")
    return verifier, challenge


@router.post("/start")
async def dropbox_oauth_start(request: Request) -> dict:
    """Open system browser with authorize URL; PKCE verifier stays on server."""
    _cleanup()
    s = get_settings()
    if not s["dropbox_app_key"] or not s["dropbox_app_secret"]:
        raise HTTPException(500, "Missing Dropbox OAuth env")
    base = str(request.base_url).rstrip("/")
    redirect_uri = f"{base}/api/oauth/dropbox/callback"
    state = secrets.token_urlsafe(32)
    verifier, challenge = _pkce_pair()
    _pending[state] = {
        "verifier": verifier,
        "redirect_uri": redirect_uri,
        "created": time.time(),
        "done": False,
        "error": None,
    }
    params = {
        "client_id": s["dropbox_app_key"],
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "token_access_type": "offline",
        "state": state,
    }
    auth_url = "https://www.dropbox.com/oauth2/authorize?" + urlencode(params)
    try:
        webbrowser.open(auth_url)
    except Exception as e:
        raise HTTPException(500, f"Could not open browser: {e}") from e
    return {"oauth_state": state, "redirect_uri": redirect_uri}


@router.get("/poll")
async def dropbox_oauth_poll(state: str) -> dict:
    _cleanup()
    p = _pending.get(state)
    if not p:
        return {"done": True, "error": "invalid_or_expired_state"}
    if p.get("error"):
        return {"done": True, "error": p["error"]}
    if p.get("done"):
        return {"done": True, "error": None}
    return {"done": False, "error": None}


@router.get("/callback")
async def dropbox_oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> HTMLResponse:
    if error:
        msg = error_description or error
        html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Dropbox</title></head>
<body style="font-family: system-ui; padding: 48px;"><p>認証に失敗しました: {msg}</p>
<p>アプリに戻ってください。</p></body></html>"""
        if state and state in _pending:
            _pending[state]["done"] = True
            _pending[state]["error"] = msg
        return HTMLResponse(html, status_code=400)
    if not code or not state:
        return HTMLResponse("Missing code or state", status_code=400)
    p = _pending.get(state)
    if not p:
        return HTMLResponse(
            "セッションが無効です。アプリから再度「Dropbox に接続」を試してください。",
            status_code=400,
        )
    s = get_settings()
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.dropbox.com/oauth2/token",
            data={
                "code": code,
                "grant_type": "authorization_code",
                "client_id": s["dropbox_app_key"],
                "client_secret": s["dropbox_app_secret"],
                "redirect_uri": p["redirect_uri"],
                "code_verifier": p["verifier"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    try:
        data = r.json()
    except Exception:
        data = {}
    if not r.is_success:
        err = data.get("error_description") or data.get("error") or r.text
        p["done"] = True
        p["error"] = str(err)
        return HTMLResponse(
            f"<html><body style='font-family:system-ui;padding:48px'><p>トークン取得に失敗: {err}</p></body></html>",
            status_code=400,
        )
    access = data.get("access_token")
    refresh = data.get("refresh_token")
    if not access:
        p["done"] = True
        p["error"] = "No access_token in response"
        return HTMLResponse("No access token", status_code=400)
    storage.save_tokens(
        dropbox_access=access,
        dropbox_refresh=refresh,
    )
    p["done"] = True
    p["error"] = None
    html = """<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Dropbox</title></head>
<body style="font-family: system-ui; padding: 48px;">
<p><strong>Dropbox に接続しました。</strong></p>
<p>このタブを閉じて、アプリに戻ってください。</p>
</body></html>"""
    return HTMLResponse(html)
