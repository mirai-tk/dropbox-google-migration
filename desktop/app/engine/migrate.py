"""Recursive Dropbox → Google Drive migration (Python port of useConverter.migrateFolderRecursively)."""
from __future__ import annotations

import asyncio
import gc
import json
import logging
import secrets
import string
from collections.abc import Awaitable, Callable
from typing import Any, AsyncIterator
from urllib.parse import quote

import httpx

from ..dropbox_oauth_refresh import (
    dropbox_request_with_token_refresh,
    refresh_dropbox_access_token,
)
from ..desktop_notify import show_desktop_notification
from ..google_docs_checklist import convert_task_markers_to_native_checklists
from ..google_oauth_refresh import google_request_with_token_refresh
from ..migration_auth import MigrationAuthError
from .paper_docx import clean_markdown, markdown_to_docx_bytes

logger = logging.getLogger(__name__)

MIGRATION_POOL_SIZE = 5
RESUMABLE_UPLOAD_THRESHOLD = 400 * 1024 * 1024
RESUMABLE_CHUNK_SIZE = 256 * 1024
RESUMABLE_CHUNK_PUT_RETRIES = 4
RESUMABLE_CHUNK_PUT_TIMEOUT = 600.0
# Web の GDRIVE_STREAM_THRESHOLD（5MB）と同じ閾値は useConverter.js にある。Python エンジンは常に multipart/related をチャンク送信し送信中バイトで UL 進捗を付ける。
CHECKPOINT_EVERY = 50

# GDrive への送信パターン（フロントの gUpload / migrateFolderRecursively と対応）
# 1) 通常ファイルかつサイズ > RESUMABLE_UPLOAD_THRESHOLD → resumable（gdrive_resumable_upload_stream）
# 2) 通常ファイルかつサイズ ≤ 閾値、または Paper → multipart（gdrive_multipart_upload）
# 3) multipart: 閾値以下は Web と同じ FormData（multipart/form-data）、超は related ストリーム

MIME_EXT = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "txt": "text/plain",
    "csv": "text/csv",
    "zip": "application/zip",
}

def ascii_safe_json(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=True)


def gdrive_upload_metadata(name: str, mime_type: str, parent_id: str) -> dict[str, Any]:
    """files.create 用。ルート（マイドライブ直下）のときは parents を省略する。

    Google の説明ではルートならフィールドを省略し、空配列 parents: [] は無効になることがある。
    """
    m: dict[str, Any] = {"name": name, "mimeType": mime_type}
    if parent_id and parent_id != "root":
        m["parents"] = [parent_id]
    return m


def dropbox_headers(
    token: str,
    content: bool,
    ns_id: str | None,
) -> dict[str, str]:
    h: dict[str, str] = {"Authorization": f"Bearer {token}"}
    if not content:
        h["Content-Type"] = "application/json"
    if ns_id:
        h["Dropbox-API-Path-Root"] = ascii_safe_json(
            {".tag": "root", "root": ns_id}
        )
    return h


def _dropbox_http_error_detail(r: httpx.Response) -> str:
    """content.dropboxapi.com の失敗理由（認証切れは多くが 401）。"""
    snippet = (r.text or "").strip().replace("\n", " ")[:1200]
    return f"HTTP {r.status_code}" + (f" — {snippet}" if snippet else "")


async def list_folder_recursive(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    ns_id: str | None,
    path: str,
) -> list[dict]:
    url = "https://api.dropboxapi.com/2/files/list_folder"
    body = {
        "path": path,
        "recursive": True,
        "include_media_info": False,
        "include_has_explicit_shared_members": False,
        "include_mounted_folders": True,
    }
    r = await dropbox_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            url,
            headers=dropbox_headers(tok, False, ns_id),
            json=body,
        ),
    )
    r.raise_for_status()
    data = r.json()
    entries = list(data.get("entries", []))
    while data.get("has_more"):
        r2 = await dropbox_request_with_token_refresh(
            client,
            token_ref,
            refresh,
            lambda tok: client.post(
                "https://api.dropboxapi.com/2/files/list_folder/continue",
                headers=dropbox_headers(tok, False, ns_id),
                json={"cursor": data["cursor"]},
            ),
        )
        r2.raise_for_status()
        data = r2.json()
        entries.extend(data.get("entries", []))
    return entries


async def list_gdrive_folder(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    folder_id: str,
) -> list[dict]:
    q = f"'{folder_id}' in parents and trashed=false"
    u = (
        "https://www.googleapis.com/drive/v3/files?"
        f"q={quote(q)}&fields=files(id,name,mimeType,size)"
        "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true"
    )
    all_files: list[dict] = []
    page_token = None
    while True:
        uu = u
        if page_token:
            uu += f"&pageToken={quote(page_token)}"
        r = await google_request_with_token_refresh(
            client,
            token_ref,
            refresh,
            lambda tok: client.get(
                uu, headers={"Authorization": f"Bearer {tok}"}
            ),
        )
        r.raise_for_status()
        data = r.json()
        all_files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return all_files


async def create_gdrive_folder(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    parent_id: str,
    name: str,
) -> str | None:
    body = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [] if parent_id == "root" else [parent_id],
    }
    r = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            json=body,
        ),
    )
    if not r.is_success:
        return None
    return r.json().get("id")


async def gdrive_file_exists(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    folder_id: str,
    file_name: str,
) -> dict | None:
    esc = file_name.replace("\\", "\\\\").replace("'", "\\'")
    q = f"'{folder_id}' in parents and name='{esc}' and trashed = false"
    u = (
        "https://www.googleapis.com/drive/v3/files?"
        f"q={quote(q)}&fields=files(id,size)&pageSize=1"
        "&supportsAllDrives=true&includeItemsFromAllDrives=true"
    )
    r = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.get(u, headers={"Authorization": f"Bearer {tok}"}),
    )
    if not r.is_success:
        return None
    files = r.json().get("files", [])
    if not files:
        return None
    f = files[0]
    return {"id": f["id"], "size": f.get("size")}


async def gdrive_delete_file(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    file_id: str,
) -> bool:
    r = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.delete(
            f"https://www.googleapis.com/drive/v3/files/{file_id}?supportsAllDrives=true",
            headers={"Authorization": f"Bearer {tok}"},
        ),
    )
    return r.is_success


# 小さめにすると related 送信の on_body_progress が細かくなり UL バーが飛びにくい
MULTIPART_UPLOAD_CHUNK = 32 * 1024


def _form_boundary_like_js() -> str:
    """useConverter.js: '----FormBoundary' + Math.random().toString(36).slice(2, 14)"""
    chars = string.ascii_lowercase + string.digits
    return "----FormBoundary" + "".join(
        secrets.choice(chars) for _ in range(12)
    )


def _multipart_file_part_for_upload(metadata: dict) -> tuple[str, str]:
    """useConverter.js: FormData の file パート（名前・Blob の型）に合わせる。

    Paper→GDoc はメタの mimeType が google-apps.document で、実体は docx。Web は Packer.toBlob の
    MIME（docx）で送る。第2パートを application/octet-stream のままにすると Drive が 400 にすることがある。
    """
    name = metadata.get("name") or "file"
    mt = metadata.get("mimeType") or ""
    if mt == "application/vnd.google-apps.document":
        return (
            f"{name}.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    return (name, mt or "application/octet-stream")


def _multipart_related_upload_body(
    boundary: str,
    meta_str: str,
    file_bytes: bytes,
    media_content_type: str,
) -> bytes:
    """useConverter.js createMultipartStream と同じ related 構造。

    第2パートの Content-Type はメディア実体に合わせる（Docx 変換時は docx の MIME）。
    """
    parts = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n{meta_str}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {media_content_type}\r\n\r\n"
    ).encode("utf-8")
    end = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return parts + file_bytes + end


async def gdrive_multipart_upload(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    metadata: dict,
    file_bytes: bytes,
    on_body_progress: Callable[[int, int], Awaitable[None]] | None = None,
) -> str | None:
    """Drive uploadType=multipart。multipart/related を httpx にチャンク供給し、送ったバイト数で進捗を付ける。

    単発の files= FormData POST は送信中のバイトが取れないため使わない。

    成功時は作成ファイルの id を返す。失敗時は None。
    """
    url = (
        "https://www.googleapis.com/upload/drive/v3/files"
        "?uploadType=multipart&supportsAllDrives=true"
    )
    meta_str = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
    _upload_fname, media_ct = _multipart_file_part_for_upload(metadata)

    boundary = _form_boundary_like_js()
    body = _multipart_related_upload_body(boundary, meta_str, file_bytes, media_ct)
    total = len(body)

    if on_body_progress:
        await on_body_progress(0, total)

    async def stream_body():
        i = 0
        while i < total:
            chunk = body[i : i + MULTIPART_UPLOAD_CHUNK]
            i += len(chunk)
            yield chunk
            if on_body_progress:
                await on_body_progress(i, total)

    r = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            url,
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            content=stream_body(),
            timeout=600.0,
        ),
    )
    if not r.is_success:
        logger.error(
            "gdrive_multipart_upload (chunked) failed status=%s meta=%s body=%s",
            r.status_code,
            meta_str[:2000],
            (r.text or "")[:4000],
        )
        return None
    if on_body_progress:
        await on_body_progress(total, total)
    try:
        data = r.json()
        return data.get("id") if isinstance(data, dict) else None
    except Exception:
        logger.exception("gdrive_multipart_upload: JSON parse failed")
        return None


async def _put_resumable_chunk(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    location: str,
    piece: bytes,
    content_range: str,
) -> httpx.Response | None:
    """resumable セッションへのチャンク PUT。応答受信前に切れる ReadError 等は再試行する。"""
    delay = 1.5
    for attempt in range(RESUMABLE_CHUNK_PUT_RETRIES):
        try:
            return await google_request_with_token_refresh(
                client,
                token_ref,
                refresh,
                lambda tok, p=piece, crn=content_range: client.put(
                    location,
                    headers={
                        "Authorization": f"Bearer {tok}",
                        "Content-Length": str(len(p)),
                        "Content-Range": crn,
                    },
                    content=p,
                    timeout=RESUMABLE_CHUNK_PUT_TIMEOUT,
                ),
            )
        except httpx.TransportError as e:
            if attempt >= RESUMABLE_CHUNK_PUT_RETRIES - 1:
                logger.warning(
                    "resumable chunk PUT failed after %d attempts: %s",
                    RESUMABLE_CHUNK_PUT_RETRIES,
                    e,
                    exc_info=True,
                )
                return None
            logger.info(
                "resumable chunk PUT retry %d/%d: %s",
                attempt + 1,
                RESUMABLE_CHUNK_PUT_RETRIES,
                e,
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)
    return None


async def gdrive_resumable_upload_stream(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    metadata: dict,
    file_size: int,
    mime_type: str,
    body_iter,
    on_upload_progress: Callable[[int], Awaitable[None]] | None = None,
) -> bool:
    r0 = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Length": str(file_size),
                "X-Upload-Content-Type": mime_type or "application/octet-stream",
            },
            json=metadata,
        ),
    )
    if not r0.is_success:
        return False
    location = r0.headers.get("Location")
    if not location:
        return False

    offset = 0
    buf = bytearray()
    async for chunk in body_iter:
        buf.extend(chunk)
        while len(buf) >= RESUMABLE_CHUNK_SIZE or (
            len(buf) > 0 and offset + len(buf) >= file_size
        ):
            take = min(
                len(buf),
                RESUMABLE_CHUNK_SIZE
                if offset + len(buf) < file_size
                else len(buf),
            )
            if take == 0:
                break
            piece = bytes(buf[:take])
            range_end = min(offset + take, file_size)
            cr = f"bytes {offset}-{range_end - 1}/{file_size}"
            r = await _put_resumable_chunk(
                client, token_ref, refresh, location, piece, cr
            )
            if r is None or r.status_code not in (200, 201, 308):
                return False
            del buf[:take]
            offset = range_end
            if on_upload_progress and file_size > 0:
                up_pct = int((offset / file_size) * 100)
                await on_upload_progress(min(100, up_pct))
            if offset >= file_size:
                if on_upload_progress:
                    await on_upload_progress(100)
                return True
    if buf:
        piece = bytes(buf)
        range_end = offset + len(piece)
        cr = f"bytes {offset}-{range_end - 1}/{file_size}"
        r = await _put_resumable_chunk(
            client, token_ref, refresh, location, piece, cr
        )
        if r is None or r.status_code not in (200, 201):
            return False
        if on_upload_progress:
            await on_upload_progress(100)
        return True
    if on_upload_progress and file_size > 0:
        await on_upload_progress(100)
    return True


async def run_folder_migration(
    *,
    root_path: str,
    root_folder_name: str,
    selected_folder_id: str,
    dropbox_token: str,
    dropbox_ns_id: str | None,
    dropbox_refresh_token: str | None = None,
    google_token: str,
    google_refresh_token: str | None = None,
    migration_id: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    token_ref: list[str] = [google_token]
    g_refresh = google_refresh_token
    dropbox_token_ref: list[str] = [dropbox_token]
    d_refresh = dropbox_refresh_token
    mid = migration_id or "migrate-py"
    yield {
        "type": "log",
        "id": mid,
        "message": f"移行開始（ネイティブ）: {root_folder_name} ({root_path})",
        "progress": 0,
        "level": "info",
    }

    event_q: asyncio.Queue = asyncio.Queue()
    completed = 0
    lock = asyncio.Lock()
    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
        migration_aborted = False
        try:
            all_entries = await list_folder_recursive(
                client, dropbox_token_ref, d_refresh, dropbox_ns_id, root_path
            )
        except MigrationAuthError as e:
            yield {
                "type": "log",
                "message": f"移行を中断しました: {e}",
                "level": "error",
                "id": mid,
            }
            return
        except Exception as e:
            yield {"type": "log", "message": f"リスト取得失敗: {e}", "level": "error"}
            return

        folders = [
            e
            for e in all_entries
            if e.get(".tag") == "folder"
            and e.get("path_lower", "").lower() != root_path.lower()
        ]
        folders.sort(
            key=lambda a: (
                a.get("path_lower", "").count("/"),
                a.get("path_lower", ""),
            )
        )
        files = [e for e in all_entries if e.get(".tag") == "file"]

        yield {
            "type": "log",
            "message": f"解析完了: フォルダ {len(folders) + 1}件, ファイル {len(files)}件",
            "level": "info",
        }

        yield {
            "type": "log",
            "message": f"ルートフォルダを確認中: {root_folder_name}...",
            "level": "info",
        }
        try:
            root_level = await list_gdrive_folder(
                client, token_ref, g_refresh, selected_folder_id
            )
            g_root_id = next(
                (
                    f["id"]
                    for f in root_level
                    if f.get("name") == root_folder_name
                    and f.get("mimeType") == "application/vnd.google-apps.folder"
                ),
                None,
            )
            if g_root_id:
                yield {
                    "type": "log",
                    "message": f"既存のルートフォルダを使用します: ID={g_root_id}",
                    "level": "info",
                }
            else:
                yield {
                    "type": "log",
                    "message": f"ルートフォルダを新規作成します: {root_folder_name}...",
                    "level": "info",
                }
                g_root_id = await create_gdrive_folder(
                    client, token_ref, g_refresh, selected_folder_id, root_folder_name
                )
                if g_root_id:
                    yield {
                        "type": "log",
                        "message": f"ルートフォルダ作成完了: ID={g_root_id}",
                        "level": "success",
                    }
            if not g_root_id:
                yield {"type": "log", "message": "ルートフォルダ作成失敗", "level": "error"}
                return
    
            folder_map: dict[str, str] = {root_path.lower(): g_root_id}
            gdrive_children_cache: dict[str, list] = {
                g_root_id: await list_gdrive_folder(client, token_ref, g_refresh, g_root_id)
            }
    
            folder_count = 1
            for folder in folders:
                parent_path = folder["path_lower"][: folder["path_lower"].rindex("/")]
                g_parent_id = folder_map.get(parent_path, selected_folder_id)
                if g_parent_id not in gdrive_children_cache:
                    gdrive_children_cache[g_parent_id] = await list_gdrive_folder(
                        client, token_ref, g_refresh, g_parent_id
                    )
                existing = next(
                    (
                        f
                        for f in gdrive_children_cache[g_parent_id]
                        if f.get("name") == folder["name"]
                        and f.get("mimeType") == "application/vnd.google-apps.folder"
                    ),
                    None,
                )
                if existing:
                    g_folder_id = existing["id"]
                else:
                    g_folder_id = await create_gdrive_folder(
                        client, token_ref, g_refresh, g_parent_id, folder["name"]
                    )
                    if g_folder_id:
                        gdrive_children_cache[g_parent_id].append(
                            {
                                "id": g_folder_id,
                                "name": folder["name"],
                                "mimeType": "application/vnd.google-apps.folder",
                            }
                        )
                if g_folder_id:
                    folder_map[folder["path_lower"]] = g_folder_id
                folder_count += 1
                fc = round((folder_count / (len(folders) + 1)) * 30)
                yield {
                    "type": "log",
                    "id": mid,
                    "message": f"移行進捗: フォルダ作成中 ({folder_count}/{len(folders) + 1})",
                    "progress": min(30, fc),
                    "level": "info",
                }
    
            yield {
                "type": "log",
                "id": mid,
                "message": f"移行進捗: ファイル移行中 (0/{len(files)})",
                "progress": 100 if len(files) == 0 else 30,
                "level": "info",
            }
    
            sem = asyncio.Semaphore(MIGRATION_POOL_SIZE)
    
            async def process_file(file: dict) -> None:
                nonlocal completed
                path_lower = file["path_lower"]
                file_name = file["name"]
                parent_path = path_lower[: path_lower.rindex("/")]
                g_parent_id = folder_map.get(parent_path, selected_folder_id)
                file_log_id = f"file-{path_lower}"
                rel = root_folder_name + "/" + (
                    path_lower[len(root_path) :].lstrip("/") or file_name
                )
    
                # Dropbox→GDrive は DL/UL を別スケールで保持し、合成 progress=(dl+ul)/2（上書きで 50% 固定に見えるのを防ぐ）
                dl_pct = [0]
                ul_pct = [0]

                async def emit_file_progress() -> None:
                    comb = int((dl_pct[0] + ul_pct[0]) / 2)
                    comb = min(100, max(0, comb))
                    await event_q.put(
                        {
                            "type": "log",
                            "id": file_log_id,
                            "message": f"ファイル移行中: {rel}...",
                            "progress": comb,
                            "progress_download": dl_pct[0],
                            "progress_upload": ul_pct[0],
                            "level": "info",
                        }
                    )
                    await asyncio.sleep(0)

                async def set_dl(p: int) -> None:
                    dl_pct[0] = min(100, max(0, p))
                    await emit_file_progress()

                async def set_ul(p: int) -> None:
                    ul_pct[0] = min(100, max(0, p))
                    await emit_file_progress()
    
                async with sem:
                    try:
                        n_files = len(files)
    
                        # Dropbox Web 形式（.web）は変換対象外。先に処理し file 行を 0% のまま残さない
                        if file_name.lower().endswith(".web"):
                            await event_q.put(
                                {
                                    "type": "log",
                                    "id": file_log_id,
                                    "message": f"スキップ（.web・Dropbox Web 形式は非対応）: {rel}",
                                    "progress": 100,
                                    "level": "info",
                                }
                            )
                            await asyncio.sleep(0)
                            return
    
                        await event_q.put(
                            {
                                "type": "log",
                                "id": file_log_id,
                                "message": f"ファイル移行中: {rel}...",
                                "progress": 0,
                                "progress_download": 0,
                                "progress_upload": 0,
                                "level": "info",
                            }
                        )
    
                        # useConverter.js の isPaperDocument と同条件 + Dropbox の export_info（Paper 専用メタ）
                        is_paper = (
                            file_name.lower().endswith(".paper")
                            or file.get("is_downloadable") is False
                            or file.get("export_info") is not None
                        )
                        base_name = (
                            file_name.rsplit(".", 1)[0] if is_paper else file_name
                        )
    
                        ex = await gdrive_file_exists(
                            client, token_ref, g_refresh, g_parent_id, base_name
                        )
                        if ex:
                            if is_paper:
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"スキップ（既存・同一）: {rel}",
                                        "progress": 100,
                                        "level": "info",
                                    }
                                )
                                await asyncio.sleep(0)
                                return
                            ds = (
                                int(file["size"])
                                if file.get("size") is not None
                                else None
                            )
                            gs = (
                                int(ex["size"])
                                if ex.get("size") is not None
                                else None
                            )
                            if ds is not None and gs is not None and ds == gs:
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"スキップ（既存・同一）: {rel}",
                                        "progress": 100,
                                        "level": "info",
                                    }
                                )
                                await asyncio.sleep(0)
                                return
                            await event_q.put(
                                {
                                    "type": "log",
                                    "message": f"上書き（容量が異なる）: {rel}",
                                    "level": "info",
                                }
                            )
                            if not await gdrive_delete_file(
                                client, token_ref, g_refresh, ex["id"]
                            ):
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"削除失敗のためスキップ: {rel}",
                                        "progress": 100,
                                        "level": "error",
                                    }
                                )
                                await asyncio.sleep(0)
                                return
    
                        if is_paper:
                            await set_dl(5)
                            r = await dropbox_request_with_token_refresh(
                                client,
                                dropbox_token_ref,
                                d_refresh,
                                lambda tok: client.post(
                                    "https://content.dropboxapi.com/2/files/export",
                                    headers={
                                        **dropbox_headers(
                                            tok, True, dropbox_ns_id
                                        ),
                                        "Dropbox-API-Arg": ascii_safe_json(
                                            {
                                                "path": path_lower,
                                                "export_format": "markdown",
                                            }
                                        ),
                                    },
                                ),
                            )
                            if not r.is_success:
                                logger.error(
                                    "Paper export failed path=%s status=%s body=%s",
                                    path_lower,
                                    r.status_code,
                                    (r.text or "")[:8000],
                                )
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"Paperエクスポート失敗: {rel}",
                                        "progress": 100,
                                        "level": "error",
                                    }
                                )
                                return
                            await set_dl(25)
                            md = clean_markdown(r.text)
                            await set_dl(45)
                            try:
                                docx_b = await markdown_to_docx_bytes(
                                    client,
                                    dropbox_token_ref,
                                    d_refresh,
                                    base_name,
                                    md,
                                )
                            except MigrationAuthError:
                                raise
                            except Exception:
                                logger.exception(
                                    "Paper markdown_to_docx_bytes failed rel=%s", rel
                                )
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"Paper docx 生成失敗: {rel}",
                                        "progress": 100,
                                        "level": "error",
                                    }
                                )
                                return
                            await set_dl(80)
                            meta = gdrive_upload_metadata(
                                base_name,
                                "application/vnd.google-apps.document",
                                g_parent_id,
                            )
                            await set_dl(100)

                            async def on_multipart_sent(sent: int, total: int) -> None:
                                if total <= 0:
                                    return
                                u = int((sent / total) * 100)
                                u = min(100, u)
                                await set_ul(u)

                            uploaded_id = await gdrive_multipart_upload(
                                client,
                                token_ref,
                                g_refresh,
                                meta,
                                docx_b,
                                on_body_progress=on_multipart_sent,
                            )
                            if uploaded_id:
                                try:
                                    await convert_task_markers_to_native_checklists(
                                        client, token_ref, g_refresh, uploaded_id
                                    )
                                except MigrationAuthError:
                                    raise
                                except Exception:
                                    logger.exception(
                                        "convert_task_markers_to_native_checklists rel=%s",
                                        rel,
                                    )
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"Paper変換完了: {rel}",
                                        "progress": 100,
                                        "progress_download": 100,
                                        "progress_upload": 100,
                                        "level": "success",
                                    }
                                )
                            else:
                                logger.error(
                                    "Paper GDrive multipart failed (see gdrive_multipart_upload log above) rel=%s",
                                    rel,
                                )
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"Paperアップロード失敗: {rel}",
                                        "progress": 100,
                                        "level": "error",
                                    }
                                )
                        else:
                            fsize = int(file.get("size") or 0)
                            ext = (
                                file_name.rsplit(".", 1)[-1].lower()
                                if "." in file_name
                                else ""
                            )
                            mime = MIME_EXT.get(ext, "application/octet-stream")
                            ok = False
    
                            if fsize > RESUMABLE_UPLOAD_THRESHOLD:
                                meta = gdrive_upload_metadata(
                                    file_name, mime, g_parent_id
                                )
    
                                async def dropbox_stream_tracked():
                                    attempt = 0
                                    while True:
                                        async with client.stream(
                                            "POST",
                                            "https://content.dropboxapi.com/2/files/download",
                                            headers={
                                                **dropbox_headers(
                                                    dropbox_token_ref[0],
                                                    True,
                                                    dropbox_ns_id,
                                                ),
                                                "Dropbox-API-Arg": ascii_safe_json(
                                                    {"path": path_lower}
                                                ),
                                            },
                                        ) as resp:
                                            if (
                                                resp.status_code == 401
                                                and attempt == 0
                                                and d_refresh
                                                and await refresh_dropbox_access_token(
                                                    client,
                                                    dropbox_token_ref,
                                                    d_refresh,
                                                )
                                            ):
                                                attempt += 1
                                                continue
                                            if resp.status_code == 401:
                                                raise MigrationAuthError(
                                                    "Dropbox の認証が無効です（ストリームダウンロード）。"
                                                    " Dropbox に再接続してから再度お試しください。"
                                                )
                                            resp.raise_for_status()
                                            loaded = 0
                                            async for ch in resp.aiter_bytes():
                                                loaded += len(ch)
                                                if fsize > 0:
                                                    await set_dl(
                                                        int(loaded / fsize * 100)
                                                    )
                                                yield ch
                                            return
    
                                async def upload_cb(pct: int) -> None:
                                    await set_ul(min(100, pct))
    
                                ok = await gdrive_resumable_upload_stream(
                                    client,
                                    token_ref,
                                    g_refresh,
                                    meta,
                                    fsize,
                                    mime,
                                    dropbox_stream_tracked(),
                                    on_upload_progress=upload_cb,
                                )
                            else:
                                await set_dl(5)
                                dr = await dropbox_request_with_token_refresh(
                                    client,
                                    dropbox_token_ref,
                                    d_refresh,
                                    lambda tok: client.post(
                                        "https://content.dropboxapi.com/2/files/download",
                                        headers={
                                            **dropbox_headers(
                                                tok, True, dropbox_ns_id
                                            ),
                                            "Dropbox-API-Arg": ascii_safe_json(
                                                {"path": path_lower}
                                            ),
                                        },
                                    ),
                                )
                                if not dr.is_success:
                                    raise RuntimeError(
                                        "Dropbox download failed: "
                                        + _dropbox_http_error_detail(dr)
                                    )
                                fb = dr.content
                                ct = dr.headers.get("Content-Type", "")
                                if ct:
                                    mime = ct.split(";")[0].strip()
                                await set_dl(100)
                                meta = gdrive_upload_metadata(
                                    file_name, mime, g_parent_id
                                )

                                async def on_multipart_sent(s: int, total: int) -> None:
                                    if total <= 0:
                                        return
                                    u = int((s / total) * 100)
                                    u = min(100, u)
                                    await set_ul(u)
    
                                uploaded_id = await gdrive_multipart_upload(
                                    client,
                                    token_ref,
                                    g_refresh,
                                    meta,
                                    fb,
                                    on_body_progress=on_multipart_sent,
                                )
                                ok = bool(uploaded_id)
                            if ok:
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"ファイル転送完了: {rel}",
                                        "progress": 100,
                                        "progress_download": 100,
                                        "progress_upload": 100,
                                        "level": "success",
                                    }
                                )
                            else:
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": file_log_id,
                                        "message": f"ファイル転送失敗: {rel}",
                                        "progress": 100,
                                        "level": "error",
                                    }
                                )
                    except MigrationAuthError:
                        raise
                    except Exception as e:
                        logger.exception("migrate file")
                        await event_q.put(
                            {
                                "type": "log",
                                "id": file_log_id,
                                "message": f"エラー: {rel} — {e}",
                                "level": "error",
                            }
                        )
                    finally:
                        async with lock:
                            completed += 1
                            n = len(files)
                            if n > 0:
                                fp = 30 + round((completed / n) * 70)
                                await event_q.put(
                                    {
                                        "type": "log",
                                        "id": mid,
                                        "message": f"移行進捗: ファイル移行中 ({completed}/{n})",
                                        "progress": min(100, fp),
                                        "level": "info",
                                    }
                                )
                            if completed % CHECKPOINT_EVERY == 0:
                                gc.collect()

            async def run_all_files() -> None:
                nonlocal migration_aborted
                tasks = [
                    asyncio.create_task(process_file(f)) for f in files
                ]
                if not tasks:
                    await event_q.put(None)
                    return
                results = await asyncio.gather(*tasks, return_exceptions=True)
                first_auth: MigrationAuthError | None = None
                for r in results:
                    if isinstance(r, MigrationAuthError):
                        if first_auth is None:
                            first_auth = r
                        migration_aborted = True
                if migration_aborted:
                    for t in tasks:
                        if not t.done():
                            t.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await event_q.put(
                        {
                            "type": "log",
                            "message": f"移行を中断しました: {first_auth}",
                            "level": "error",
                            "id": mid,
                        }
                    )
                await event_q.put(None)

            # ストリーム切断などでジェネレータが閉じると async with が先に抜けて
            # httpx クライアントだけ閉じ、run_all_files がまだ PUT 中だと
            # "Cannot send a request, as the client has been closed" になる。
            # runner を finally でキャンセル・待機してからクライアントを閉じる。
            runner = asyncio.create_task(run_all_files())
            try:
                while True:
                    ev = await event_q.get()
                    if ev is None:
                        break
                    yield ev
                await runner
            finally:
                if not runner.done():
                    runner.cancel()
                    try:
                        await runner
                    except asyncio.CancelledError:
                        pass

        except MigrationAuthError as e:
            yield {
                "type": "log",
                "message": f"移行を中断しました: {e}",
                "level": "error",
                "id": mid,
            }
            return

        if not migration_aborted:
            await asyncio.to_thread(
                show_desktop_notification,
                "Dropbox → Google Drive",
                f'「{root_folder_name}」の移行が完了しました',
            )
            yield {
                "type": "log",
                "message": f'✅ 移行完了: "{root_folder_name}"',
                "level": "success",
                "id": mid,
                "progress": 100,
            }
