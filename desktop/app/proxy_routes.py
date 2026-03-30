"""Image proxies (same behavior as Vite / Netlify)."""
from typing import Annotated

import httpx
from fastapi import APIRouter, Header
from fastapi.responses import Response

router = APIRouter(tags=["proxy"])


@router.get("/proxy/dropbox-image/{path:path}")
async def proxy_dropbox_image(
    path: str,
    authorization: Annotated[str | None, Header()] = None,
):
    """markdownParser が送る Bearer を paper-attachments 取得に転送する（未署名URL対策）。"""
    url = f"https://paper-attachments.dropboxusercontent.com/{path}"
    headers: dict[str, str] = {"User-Agent": "Mozilla/5.0"}
    if authorization:
        headers["Authorization"] = authorization
    async with httpx.AsyncClient(follow_redirects=True) as client:
        r = await client.get(url, headers=headers)
    if not r.is_success:
        return Response(status_code=r.status_code)
    return Response(
        content=r.content,
        media_type=r.headers.get("Content-Type", "image/jpeg"),
    )
