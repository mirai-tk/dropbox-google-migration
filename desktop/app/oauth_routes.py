"""OAuth token exchange routes (same contract as source/vite.config.js middleware)."""
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .config import get_settings

router = APIRouter(prefix="/api", tags=["oauth"])


class GoogleTokenBody(BaseModel):
    code: str | None = None
    redirect_uri: str | None = None


class GoogleRefreshBody(BaseModel):
    refresh_token: str


class DropboxTokenBody(BaseModel):
    code: str
    redirect_uri: str
    code_verifier: str


class DropboxRefreshBody(BaseModel):
    refresh_token: str


def _json_or_raw(r: httpx.Response) -> dict:
    ct = r.headers.get("content-type", "")
    if ct.startswith("application/json"):
        return r.json()
    return {"raw": r.text}


@router.post("/google/token")
async def google_token(body: GoogleTokenBody):
    s = get_settings()
    if not s["google_client_id"] or not s["google_client_secret"]:
        raise HTTPException(500, "Missing Google OAuth env (VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_SECRET)")
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": body.code or "",
                "client_id": s["google_client_id"],
                "client_secret": s["google_client_secret"],
                "redirect_uri": body.redirect_uri or "postmessage",
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    data = _json_or_raw(r)
    if not r.is_success:
        return JSONResponse(content=data, status_code=r.status_code)
    return data


@router.post("/google/refresh")
async def google_refresh(body: GoogleRefreshBody):
    s = get_settings()
    if not s["google_client_id"] or not s["google_client_secret"]:
        raise HTTPException(500, "Missing Google OAuth env")
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "refresh_token": body.refresh_token,
                "client_id": s["google_client_id"],
                "client_secret": s["google_client_secret"],
                "grant_type": "refresh_token",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    data = _json_or_raw(r)
    if not r.is_success:
        return JSONResponse(content=data, status_code=r.status_code)
    return data


@router.post("/dropbox/token")
async def dropbox_token(body: DropboxTokenBody):
    s = get_settings()
    if not s["dropbox_app_key"] or not s["dropbox_app_secret"]:
        raise HTTPException(500, "Missing Dropbox OAuth env")
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.dropbox.com/oauth2/token",
            data={
                "code": body.code,
                "grant_type": "authorization_code",
                "client_id": s["dropbox_app_key"],
                "client_secret": s["dropbox_app_secret"],
                "redirect_uri": body.redirect_uri,
                "code_verifier": body.code_verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    data = _json_or_raw(r)
    if not r.is_success:
        return JSONResponse(content=data, status_code=r.status_code)
    return data


@router.post("/dropbox/refresh")
async def dropbox_refresh(body: DropboxRefreshBody):
    s = get_settings()
    if not s["dropbox_app_key"] or not s["dropbox_app_secret"]:
        raise HTTPException(500, "Missing Dropbox OAuth env")
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.dropbox.com/oauth2/token",
            data={
                "refresh_token": body.refresh_token,
                "grant_type": "refresh_token",
                "client_id": s["dropbox_app_key"],
                "client_secret": s["dropbox_app_secret"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    data = _json_or_raw(r)
    if not r.is_success:
        return JSONResponse(content=data, status_code=r.status_code)
    return data


@router.get("/proxy-image")
async def proxy_image(url: str):
    if not url.startswith("http://") and not url.startswith("https://"):
        raise HTTPException(400, "Invalid URL")
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail="Image fetch failed (network or DNS error)",
        ) from exc
    if not r.is_success:
        raise HTTPException(r.status_code)
    from fastapi.responses import Response

    return Response(content=r.content, media_type=r.headers.get("Content-Type", "image/jpeg"))
