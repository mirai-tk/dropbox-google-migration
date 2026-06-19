"""GDrive 等に置かれた .paper ショートカット（JSON）から Paper 本文を export する。"""
from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from ..dropbox_oauth_refresh import dropbox_request_with_token_refresh
from .migrate import ascii_safe_json, dropbox_headers

logger = logging.getLogger(__name__)

_CLOUD_DOCS_VIEW_RE = re.compile(r"/cloud_docs/view/([^/?#]+)", re.I)
_PAPER_EXT_RE = re.compile(r"\.(paper|papert)$", re.I)
_PAREN_RE = re.compile(r"[（(][^）)]*[）)]")
_CLIENT_SUFFIX_RE = re.compile(r"様$")
_SALES_MINUTES_RE = re.compile(r"^商談議事録$")


def parse_paper_shortcut_text(text: str) -> dict[str, Any] | None:
    try:
        data = json.loads(text.strip())
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    url = data.get("url")
    if not isinstance(url, str):
        return None
    m = _CLOUD_DOCS_VIEW_RE.search(url)
    if not m:
        return None
    cap = data.get("content_access_token")
    view_id = m.group(1)
    file_id_gid = None
    try:
        qs = parse_qs(urlparse(url).query)
        gid = qs.get("fileid_gid") or qs.get("file_id")
        if gid and isinstance(gid[0], str) and gid[0].strip():
            raw = gid[0].strip()
            file_id_gid = raw if raw.startswith("id:") else f"id:{raw}"
    except Exception:
        pass
    return {
        "view_id": view_id,
        "doc_id": view_id,
        "url": url,
        "file_id_gid": file_id_gid,
        "content_access_token": cap if isinstance(cap, str) else None,
    }


def _attempt_log(method: str, status: int, detail: str = "") -> dict[str, Any]:
    return {"method": method, "status": status, "detail": detail[:400]}


def _is_shared_link_url(url: str) -> bool:
    return bool(_SHARED_LINK_RE.search(url or ""))


def _is_paper_file_metadata(md: dict) -> bool:
    name = md.get("name") or ""
    if _PAPER_EXT_RE.search(name):
        return True
    if md.get("export_info") is not None:
        return True
    if md.get("is_downloadable") is False:
        return True
    return False


def _paper_path_from_metadata(md: dict) -> str | None:
    return md.get("path_lower") or md.get("path_display") or None


def _normalize_paper_name(name: str) -> str:
    n = _PAPER_EXT_RE.sub("", (name or "").strip())
    n = _PAREN_RE.sub("", n).strip()
    return n.lower()


def _paper_filename_parts(file_name: str) -> list[str]:
    base = _PAPER_EXT_RE.sub("", (file_name or "").strip())
    base = _PAREN_RE.sub("", base).strip()
    return [p for p in re.split(r"[_\s]+", base) if p and len(p) >= 2]


def _client_name_variants(part: str) -> list[str]:
    variants: list[str] = []
    p = (part or "").strip()
    if not p:
        return variants
    if p not in variants:
        variants.append(p)
    no_sama = _CLIENT_SUFFIX_RE.sub("", p).strip()
    if no_sama and no_sama not in variants:
        variants.append(no_sama)
    if no_sama and f"{no_sama}様" not in variants:
        variants.append(f"{no_sama}様")
    return variants


def _paper_search_queries(file_name: str) -> list[str]:
    """GDrive 上のファイル名から Dropbox search 用クエリ候補を生成。"""
    raw = (file_name or "").strip()
    base = _PAPER_EXT_RE.sub("", raw).strip()
    no_paren = _PAREN_RE.sub("", base).strip()
    queries: list[str] = []

    def add(q: str) -> None:
        q = (q or "").strip()
        if q and q not in queries and len(q) >= 2:
            queries.append(q)

    add(raw)
    add(base)
    add(no_paren)
    add(f"{no_paren}.paper")
    add(f'"{raw}"')
    add(f'"{base}"')
    add(f'"{no_paren}"')
    if "_" in no_paren:
        add(no_paren.replace("_", " "))
        add(base.replace("_", " "))

    parts = _paper_filename_parts(file_name)
    topic_parts = [p for p in parts if not _SALES_MINUTES_RE.match(p)]

    for part in parts:
        add(part)
        for variant in _client_name_variants(part):
            add(variant)

    if len(parts) >= 2:
        add("_".join(parts[:2]))
        add(" ".join(parts[:2]))
    if len(parts) >= 3:
        add("_".join(parts[:3]))
        add("_".join(parts[1:3]))
        add("_".join([parts[0], parts[2]]))
        add("_".join([parts[1], parts[2]]))
        add(" ".join(parts[1:3]))

    # Dropbox 側は「商談議事録_YYYYMM_トピック_クライアント様」形式のことが多い
    if len(topic_parts) >= 2:
        for client in _client_name_variants(topic_parts[0]):
            for topic in topic_parts[1:]:
                add(f"商談議事録_{topic}_{client}")
                add(f"商談議事録_{client}_{topic}")
                add(f"{topic}_{client}")
                add(f"{client}_{topic}")

    return queries[:30]


_SEARCH_OPTION_VARIANTS: list[dict[str, Any]] = [
    {"filename_only": True, "max_results": 100},
    {"filename_only": False, "max_results": 100},
    {"filename_only": True, "file_extensions": ["paper"], "max_results": 100},
]


def _unwrap_search_file_metadata(match: dict) -> dict | None:
    md_wrap = match.get("metadata")
    if not isinstance(md_wrap, dict):
        return None
    tag = md_wrap.get(".tag")
    if tag == "file":
        return md_wrap
    if tag == "metadata":
        inner = md_wrap.get("metadata")
        if isinstance(inner, dict) and inner.get(".tag") == "file":
            return inner
    return None


def _unwrap_search_folder_metadata(match: dict) -> dict | None:
    md_wrap = match.get("metadata")
    if not isinstance(md_wrap, dict):
        return None
    tag = md_wrap.get(".tag")
    if tag == "folder":
        return md_wrap
    if tag == "metadata":
        inner = md_wrap.get("metadata")
        if isinstance(inner, dict) and inner.get(".tag") == "folder":
            return inner
    return None


def _export_ref_from_metadata(md: dict) -> str | None:
    path = _paper_path_from_metadata(md)
    file_id = md.get("id")
    if isinstance(file_id, str) and file_id:
        return file_id
    return path


def _query_matches_target(query: str, file_name: str) -> bool:
    target = _normalize_paper_name(file_name)
    q = _normalize_paper_name(query)
    if not target or not q:
        return False
    if target == q:
        return True
    longer, shorter = (target, q) if len(target) >= len(q) else (q, target)
    return longer.startswith(shorter) and len(shorter) >= 10


async def _files_get_metadata_refreshed(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    path_or_id: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
) -> dict | None:
    r = await dropbox_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            "https://api.dropboxapi.com/2/files/get_metadata",
            headers=dropbox_headers(tok, False, None if skip_ns else ns_id),
            json={"path": path_or_id, "include_media_info": False},
        ),
    )
    if not r.is_success:
        return None
    try:
        data = r.json()
    except Exception:
        return None
    return data if isinstance(data, dict) and data.get(".tag") == "file" else None


async def _enrich_paper_candidate(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    entry: dict[str, str],
    ns_id: str | None,
    attempts: list[dict[str, Any]],
) -> dict[str, str]:
    if entry.get("path") and entry.get("name"):
        return entry
    ref = entry.get("id") or entry.get("path")
    if not ref:
        return entry
    for skip_ns in (True, False):
        md = await _files_get_metadata_refreshed(
            client, token_ref, refresh, ref, ns_id, skip_ns=skip_ns
        )
        if not isinstance(md, dict):
            continue
        enriched = dict(entry)
        if md.get("name"):
            enriched["name"] = md["name"]
        path = _paper_path_from_metadata(md)
        if path:
            enriched["path"] = path
        if md.get("id"):
            enriched["id"] = md["id"]
        attempts.append(
            _attempt_log(
                f"get_metadata ref={ref}",
                200,
                json.dumps(
                    {
                        "name": enriched.get("name"),
                        "path": enriched.get("path"),
                        "id": enriched.get("id"),
                    },
                    ensure_ascii=False,
                ),
            )
        )
        return enriched
    attempts.append(_attempt_log(f"get_metadata ref={ref}", 404, "not found"))
    return entry


def _paper_names_match(file_name: str, candidate_name: str) -> bool:
    target = _normalize_paper_name(file_name)
    name = _normalize_paper_name(candidate_name)
    if not target or not name:
        return False
    if target == name:
        return True
    longer, shorter = (target, name) if len(target) >= len(name) else (name, target)
    return longer.startswith(shorter) and len(shorter) >= 10


def _paper_part_overlap_score(file_name: str, candidate_name: str) -> int:
    target_parts = [
        _CLIENT_SUFFIX_RE.sub("", p).lower()
        for p in _paper_filename_parts(file_name)
        if not _SALES_MINUTES_RE.match(p)
    ]
    cand_parts = [
        _CLIENT_SUFFIX_RE.sub("", p).lower()
        for p in _paper_filename_parts(candidate_name)
        if not _SALES_MINUTES_RE.match(p)
    ]
    score = 0
    for t in target_parts:
        for c in cand_parts:
            if t == c or (len(t) >= 4 and t in c) or (len(c) >= 4 and c in t):
                score += 1
                break
    return score


async def _read_export_body(r: httpx.Response) -> str | None:
    if not r.is_success:
        return None
    text = r.text
    return text if text else None


async def _files_export(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
    extra_arg: dict[str, Any] | None = None,
) -> httpx.Response:
    headers = dropbox_headers(token, True, None if skip_ns else ns_id)
    arg: dict[str, Any] = {"path": path, "export_format": "markdown"}
    if extra_arg:
        arg.update(extra_arg)
    headers["Dropbox-API-Arg"] = ascii_safe_json(arg)
    return await client.post(
        "https://content.dropboxapi.com/2/files/export",
        headers=headers,
    )


async def _files_download_text(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
) -> httpx.Response:
    headers = dropbox_headers(token, True, None if skip_ns else ns_id)
    headers["Dropbox-API-Arg"] = ascii_safe_json({"path": path})
    return await client.post(
        "https://content.dropboxapi.com/2/files/download",
        headers=headers,
    )


async def _resolve_cloud_docs_redirect(
    client: httpx.AsyncClient,
    token: str,
    cloud_docs_url: str,
    content_access_token: str | None,
    attempts: list[dict[str, Any]],
) -> str | None:
    """cloud_docs/view URL を GET し、共有リンク (scl/fi/...) へ追従する。"""
    header_variants: list[dict[str, str]] = [
        {
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0 (compatible; PaperMigrator/1.0)",
        }
    ]
    if content_access_token:
        header_variants.append(
            {
                "Authorization": f"Bearer {content_access_token}",
                "User-Agent": "Mozilla/5.0 (compatible; PaperMigrator/1.0)",
            }
        )

    for idx, headers in enumerate(header_variants):
        try:
            r = await client.get(
                cloud_docs_url,
                headers=headers,
                follow_redirects=True,
            )
            final = str(r.url)
            attempts.append(
                _attempt_log(
                    f"cloud_docs redirect try={idx + 1}",
                    r.status_code,
                    final[:400],
                )
            )
            if _is_shared_link_url(final):
                return final
        except Exception as exc:
            attempts.append(
                _attempt_log(
                    f"cloud_docs redirect try={idx + 1}",
                    0,
                    str(exc),
                )
            )
    return None


async def _export_via_shared_link_url(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    shared_url: str,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
    oauth_export_by_path,
) -> tuple[str | None, str | None]:
    if not _is_shared_link_url(shared_url):
        return None, None

    for use_ns in (True, False):
        r = await dropbox_request_with_token_refresh(
            client,
            token_ref,
            refresh,
            lambda tok, un=use_ns: client.post(
                "https://api.dropboxapi.com/2/sharing/get_shared_link_metadata",
                headers=dropbox_headers(tok, False, ns_id if un else None),
                json={"url": shared_url},
            ),
        )
        attempts.append(
            _attempt_log(
                f"sharing/get_shared_link_metadata ({'with ns' if use_ns else 'no ns'}) url={shared_url[:120]}",
                r.status_code,
                r.text or "",
            )
        )
        if not r.is_success:
            continue
        try:
            data = r.json()
        except Exception:
            continue
        path = data.get("path_lower")
        file_id = data.get("id")
        if path:
            text = await oauth_export_by_path(path, f"shared_link path={path}")
            if text:
                return text, f"files/export {path} (shared link metadata)"
        if file_id:
            text = await oauth_export_by_path(file_id, f"shared_link id={file_id}")
            if text:
                return text, f"files/export {file_id} (shared link metadata)"
    return None, None


async def _list_folder_entries_refreshed(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    folder_path: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
) -> list[dict]:
    r = await dropbox_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            "https://api.dropboxapi.com/2/files/list_folder",
            headers=dropbox_headers(tok, False, None if skip_ns else ns_id),
            json={
                "path": folder_path,
                "recursive": False,
                "include_media_info": False,
            },
        ),
    )
    if not r.is_success:
        return []
    try:
        data = r.json()
    except Exception:
        return []
    entries = list(data.get("entries") or [])
    while data.get("has_more"):
        r2 = await dropbox_request_with_token_refresh(
            client,
            token_ref,
            refresh,
            lambda tok: client.post(
                "https://api.dropboxapi.com/2/files/list_folder/continue",
                headers=dropbox_headers(tok, False, None if skip_ns else ns_id),
                json={"cursor": data["cursor"]},
            ),
        )
        if not r2.is_success:
            break
        try:
            data = r2.json()
        except Exception:
            break
        entries.extend(data.get("entries") or [])
    return entries


async def _list_folder_find_exact_name_refreshed(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    folder_path: str,
    file_name: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
) -> dict | None:
    entries = await _list_folder_entries_refreshed(
        client, token_ref, refresh, folder_path, ns_id, skip_ns=skip_ns
    )
    target = file_name.lower()
    base = _PAPER_EXT_RE.sub("", file_name).lower()
    for entry in entries:
        if entry.get(".tag") != "file":
            continue
        name = entry.get("name") or ""
        nl = name.lower()
        if nl == target or _PAPER_EXT_RE.sub("", nl) == base:
            if _is_paper_file_metadata(entry):
                return entry
    return None


async def _paper_docs_download(
    client: httpx.AsyncClient,
    token: str,
    doc_id: str,
    ns_id: str | None,
    *,
    skip_ns: bool = False,
) -> httpx.Response:
    headers = dropbox_headers(token, True, None if skip_ns else ns_id)
    headers["Dropbox-API-Arg"] = ascii_safe_json(
        {"doc_id": doc_id, "export_format": "markdown"}
    )
    return await client.post(
        "https://content.dropboxapi.com/2/paper/docs/download",
        headers=headers,
    )


async def _try_paper_docs_download(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    view_id: str,
    content_access_token: str | None,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
) -> str | None:
    for skip_ns in (True, False):
        tag = f"paper/docs/download oauth ({'no ns' if skip_ns else 'with ns'})"
        r = await dropbox_request_with_token_refresh(
            client,
            token_ref,
            refresh,
            lambda tok, sn=skip_ns: _paper_docs_download(
                client, tok, view_id, ns_id, skip_ns=sn
            ),
        )
        attempts.append(_attempt_log(tag, r.status_code, r.text or ""))
        body = await _read_export_body(r)
        if body is not None:
            return body

    if content_access_token:
        for skip_ns in (True, False):
            tag = f"paper/docs/download cap ({'no ns' if skip_ns else 'with ns'})"
            r = await _paper_docs_download(
                client, content_access_token, view_id, ns_id, skip_ns=skip_ns
            )
            attempts.append(_attempt_log(tag, r.status_code, r.text or ""))
            body = await _read_export_body(r)
            if body is not None:
                return body
    return None


async def _discover_torihikisaki_roots(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
) -> list[str]:
    roots: list[str] = []
    seen: set[str] = set()

    def add_root(path: str | None) -> None:
        if not path or path in seen:
            return
        seen.add(path)
        roots.append(path)

    for path in (
        "/Salesforce Documents/取引先",
        "/salesforce documents/取引先",
    ):
        for skip_ns in (True, False):
            entries = await _list_folder_entries_refreshed(
                client, token_ref, refresh, path, ns_id, skip_ns=skip_ns
            )
            if entries:
                add_root(path.lower())
                attempts.append(_attempt_log(f"torihikisaki root path={path}", 200, ""))
                break

    for query in ("取引先", "Salesforce Documents 取引先"):
        for use_ns in (True, False):
            r = await dropbox_request_with_token_refresh(
                client,
                token_ref,
                refresh,
                lambda tok, q=query, un=use_ns: client.post(
                    "https://api.dropboxapi.com/2/files/search_v2",
                    headers=dropbox_headers(tok, False, ns_id if un else None),
                    json={
                        "query": q,
                        "options": {"filename_only": True, "max_results": 20},
                    },
                ),
            )
            if not r.is_success:
                continue
            try:
                data = r.json()
            except Exception:
                continue
            for match in data.get("matches") or []:
                folder_md = _unwrap_search_folder_metadata(match)
                if not folder_md:
                    continue
                folder_path = _paper_path_from_metadata(folder_md)
                if not folder_path:
                    continue
                if folder_path.lower().endswith("取引先"):
                    add_root(folder_path)

    return roots


async def _browse_client_tree_for_paper(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    file_name: str,
    view_id: str,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
    oauth_export_by_path,
) -> tuple[str | None, str | None]:
    """search に頼らず 取引先 配下を list して同名 Paper を探す。"""
    client_tokens: set[str] = set()
    for part in _paper_filename_parts(file_name):
        if _SALES_MINUTES_RE.match(part):
            continue
        for variant in _client_name_variants(part):
            token = _CLIENT_SUFFIX_RE.sub("", variant).lower()
            if len(token) >= 2:
                client_tokens.add(token)

    roots = await _discover_torihikisaki_roots(
        client, token_ref, refresh, ns_id, attempts
    )
    if not roots:
        attempts.append(_attempt_log("torihikisaki browse", 404, "no roots"))
        return None, None

    meeting_folder = "10_商談議事録"
    scanned_clients = 0

    for root in roots[:3]:
        for skip_ns in (True, False):
            client_folders = await _list_folder_entries_refreshed(
                client, token_ref, refresh, root, ns_id, skip_ns=skip_ns
            )
            if not client_folders:
                continue

            for folder in client_folders:
                if folder.get(".tag") != "folder":
                    continue
                if scanned_clients >= 300:
                    break
                folder_path = _paper_path_from_metadata(folder)
                folder_name = (folder.get("name") or "").lower()
                if not folder_path:
                    continue
                if client_tokens and not any(
                    tok in folder_name or tok in folder_path.lower()
                    for tok in client_tokens
                ):
                    continue
                scanned_clients += 1
                meeting_path = f"{folder_path.rstrip('/')}/{meeting_folder}"
                hit = await _list_folder_find_exact_name_refreshed(
                    client,
                    token_ref,
                    refresh,
                    meeting_path,
                    file_name,
                    ns_id,
                    skip_ns=skip_ns,
                )
                if not isinstance(hit, dict):
                    continue
                export_ref = _export_ref_from_metadata(hit) or folder_path
                path = _paper_path_from_metadata(hit) or export_ref
                attempts.append(
                    _attempt_log(
                        f"client tree exact name path={path}",
                        200,
                        hit.get("name") or file_name,
                    )
                )
                view_id_ok: bool | None = None
                for dl_ns in (True, False):
                    dl = await dropbox_request_with_token_refresh(
                        client,
                        token_ref,
                        refresh,
                        lambda tok, p=path, sn=dl_ns: _files_download_text(
                            client, tok, p, ns_id, skip_ns=sn
                        ),
                    )
                    if not dl.is_success:
                        continue
                    shortcut = parse_paper_shortcut_text(dl.text or "")
                    if shortcut:
                        view_id_ok = shortcut.get("view_id") == view_id
                        if not view_id_ok:
                            attempts.append(
                                _attempt_log(
                                    f"client tree view_id mismatch path={path}",
                                    409,
                                    shortcut.get("view_id") or "",
                                )
                            )
                        break
                if view_id_ok is False:
                    continue
                text = await oauth_export_by_path(
                    export_ref, f"path={export_ref} (client tree)"
                )
                if text:
                    return export_ref, text

    attempts.append(
        _attempt_log(
            "client tree browse",
            404,
            f"scanned_clients={scanned_clients}",
        )
    )
    return None, None


async def _find_paper_in_meeting_folders(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    file_name: str,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """10_商談議事録 フォルダをたどり、完全一致ファイル名を探す。"""
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    client_parts = [
        p
        for p in _paper_filename_parts(file_name)
        if not _SALES_MINUTES_RE.match(p)
    ]
    folder_queries = ["10_商談議事録"]
    for part in client_parts:
        for variant in _client_name_variants(part):
            folder_queries.append(f"10_商談議事録 {variant}")
            folder_queries.append(variant)

    for query in folder_queries[:8]:
        for use_ns in (True, False):
            for options in _SEARCH_OPTION_VARIANTS[:2]:
                r = await dropbox_request_with_token_refresh(
                    client,
                    token_ref,
                    refresh,
                    lambda tok, q=query, opt=options, un=use_ns: client.post(
                        "https://api.dropboxapi.com/2/files/search_v2",
                        headers=dropbox_headers(tok, False, ns_id if un else None),
                        json={"query": q, "options": opt},
                    ),
                )
                tag = f"folder search query={query!r} ns={use_ns}"
                attempts.append(_attempt_log(tag, r.status_code, r.text or ""))
                if not r.is_success:
                    continue
                try:
                    data = r.json()
                except Exception:
                    continue
                for match in data.get("matches") or []:
                    folder_md = _unwrap_search_folder_metadata(match)
                    if not folder_md:
                        continue
                    folder_path = _paper_path_from_metadata(folder_md)
                    if not folder_path or folder_path in seen:
                        continue
                    path_lc = folder_path.lower()
                    if not path_lc.endswith("10_商談議事録"):
                        continue
                    if client_parts and not any(
                        _CLIENT_SUFFIX_RE.sub("", v).lower() in path_lc
                        for part in client_parts
                        for v in _client_name_variants(part)
                    ):
                        continue
                    seen.add(folder_path)
                    for skip_ns in (True, False):
                        hit = await _list_folder_find_exact_name_refreshed(
                            client,
                            token_ref,
                            refresh,
                            folder_path,
                            file_name,
                            ns_id,
                            skip_ns=skip_ns,
                        )
                        if not isinstance(hit, dict):
                            continue
                        export_ref = _export_ref_from_metadata(hit)
                        if not export_ref:
                            continue
                        entry = {
                            "name": hit.get("name") or file_name,
                            "path": _paper_path_from_metadata(hit) or "",
                            "id": hit.get("id") or "",
                            "query": f"list_folder:{folder_path}",
                        }
                        found.append(entry)
                        attempts.append(
                            _attempt_log(
                                f"exact name in folder path={folder_path}",
                                200,
                                entry.get("name") or "",
                            )
                        )
                        break
    return found


async def _search_paper_candidates(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    file_name: str,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
    oauth_export_by_path=None,
) -> list[dict[str, str]]:
    """ファイル名候補で Dropbox 内の Paper を検索し path / id を返す。"""
    found: list[dict[str, str]] = []
    seen: set[str] = set()

    for query in _paper_search_queries(file_name):
        for use_ns in (True, False):
            for options in _SEARCH_OPTION_VARIANTS:
                cursor: str | None = None
                for page in range(3):
                    if cursor:
                        url = "https://api.dropboxapi.com/2/files/search/continue_v2"
                        body: dict[str, Any] = {"cursor": cursor}
                    else:
                        url = "https://api.dropboxapi.com/2/files/search_v2"
                        body = {"query": query, "options": options}

                    r = await dropbox_request_with_token_refresh(
                        client,
                        token_ref,
                        refresh,
                        lambda tok, u=url, b=body, un=use_ns: client.post(
                            u,
                            headers=dropbox_headers(tok, False, ns_id if un else None),
                            json=b,
                        ),
                    )
                    opt_tag = "fn" if options.get("filename_only") else "all"
                    ns_tag = "with ns" if use_ns else "no ns"
                    tag = (
                        f"search_v2 query={query!r} {opt_tag} {ns_tag} page={page + 1}"
                    )
                    attempts.append(_attempt_log(tag, r.status_code, r.text or ""))
                    if not r.is_success:
                        break
                    try:
                        data = r.json()
                    except Exception:
                        break

                    strong_query = _query_matches_target(query, file_name)

                    for match in data.get("matches") or []:
                        md = _unwrap_search_file_metadata(match)
                        if not md or not _is_paper_file_metadata(md):
                            continue
                        export_ref = _export_ref_from_metadata(md)
                        name = md.get("name") or ""
                        key = export_ref or name
                        if not key or key in seen:
                            continue
                        seen.add(key)
                        entry: dict[str, str] = {"name": name, "query": query}
                        path = _paper_path_from_metadata(md)
                        if path:
                            entry["path"] = path
                        file_id = md.get("id")
                        if isinstance(file_id, str) and file_id:
                            entry["id"] = file_id
                        found.append(entry)

                        if (
                            oauth_export_by_path
                            and strong_query
                            and export_ref
                            and (
                                _paper_names_match(file_name, name)
                                or md.get("export_info") is not None
                            )
                        ):
                            attempts.append(
                                _attempt_log(
                                    f"search hit export ref={export_ref}",
                                    200,
                                    name or query,
                                )
                            )
                            text = await oauth_export_by_path(
                                export_ref, f"path={export_ref} (search hit)"
                            )
                            if text:
                                entry["export_text"] = text
                                return found

                    if not data.get("has_more"):
                        break
                    cursor = data.get("cursor")
                    if not cursor:
                        break

    folder_hits = await _find_paper_in_meeting_folders(
        client, token_ref, refresh, file_name, ns_id, attempts
    )
    for entry in folder_hits:
        key = entry.get("id") or entry.get("path") or entry.get("name")
        if key and key not in seen:
            seen.add(key)
            found.append(entry)

    attempts.append(
        _attempt_log(
            "search candidates",
            200,
            json.dumps(found[:8], ensure_ascii=False),
        )
    )
    return found


async def _find_path_by_view_id_scan(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    view_id: str,
    file_name: str,
    ns_id: str | None,
    attempts: list[dict[str, Any]],
    oauth_export_by_path,
) -> tuple[str | None, str | None]:
    """検索ヒット Paper のショートカット JSON を読み view_id が一致するパスを返す。"""
    candidates = await _search_paper_candidates(
        client,
        token_ref,
        refresh,
        file_name,
        ns_id,
        attempts,
        oauth_export_by_path,
    )

    for entry in candidates:
        if entry.get("export_text"):
            export_ref = entry.get("path") or entry.get("id")
            return export_ref, entry["export_text"]

    name_matches: list[dict[str, str]] = []
    seen_match_keys: set[str] = set()

    for raw_entry in candidates[:40]:
        entry = await _enrich_paper_candidate(
            client, token_ref, refresh, raw_entry, ns_id, attempts
        )
        name = entry.get("name") or entry.get("query") or ""
        path = entry.get("path")
        file_id = entry.get("id")
        download_ref = path or file_id

        if _paper_names_match(file_name, name) or _query_matches_target(
            entry.get("query") or "", file_name
        ):
            key = download_ref or name
            if key and key not in seen_match_keys:
                seen_match_keys.add(key)
                name_matches.append(entry)

        if not download_ref:
            continue
        for skip_ns in (True, False):
            dl = await dropbox_request_with_token_refresh(
                client,
                token_ref,
                refresh,
                lambda tok, p=download_ref, sn=skip_ns: _files_download_text(
                    client, tok, p, ns_id, skip_ns=sn
                ),
            )
            if not dl.is_success:
                continue
            shortcut = parse_paper_shortcut_text(dl.text or "")
            if shortcut and shortcut.get("view_id") == view_id:
                attempts.append(
                    _attempt_log(
                        f"view_id match via scan ref={download_ref}",
                        200,
                        view_id,
                    )
                )
                return download_ref, None

    for entry in name_matches:
        export_path = entry.get("path") or entry.get("id")
        if not export_path:
            continue
        attempts.append(
            _attempt_log(
                f"name match export ref={export_path}",
                200,
                entry.get("name") or entry.get("query") or "",
            )
        )
        text = await oauth_export_by_path(
            export_path, f"path={export_path} (name match)"
        )
        if text:
            return export_path, text

    return None, None


async def export_paper_markdown_from_shortcut(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    view_id: str,
    content_access_token: str | None,
    ns_id: str | None,
    file_name: str | None = None,
    file_id_gid: str | None = None,
    cloud_docs_url: str | None = None,
    shared_link_url: str | None = None,
) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []

    async def oauth_export_by_path(
        path: str,
        label: str,
        *,
        extra_arg: dict[str, Any] | None = None,
    ) -> str | None:
        for skip_ns in (True, False):
            tag = f"{label}{' (no ns)' if skip_ns else ''}"
            r = await dropbox_request_with_token_refresh(
                client,
                token_ref,
                refresh,
                lambda tok, p=path, sn=skip_ns, ea=extra_arg: _files_export(
                    client, tok, p, ns_id, skip_ns=sn, extra_arg=ea
                ),
            )
            attempts.append(
                _attempt_log(f"files/export {tag}", r.status_code, r.text or "")
            )
            body = await _read_export_body(r)
            if body is not None:
                return body
        return None

    # 0) cloud_docs → 共有リンク → metadata → export
    link_candidates: list[str] = []
    if shared_link_url and _is_shared_link_url(shared_link_url):
        link_candidates.append(shared_link_url)
    if cloud_docs_url:
        resolved = await _resolve_cloud_docs_redirect(
            client,
            token_ref[0],
            cloud_docs_url,
            content_access_token,
            attempts,
        )
        if resolved and resolved not in link_candidates:
            link_candidates.append(resolved)

    for shared_url in link_candidates:
        text, via = await _export_via_shared_link_url(
            client,
            token_ref,
            refresh,
            shared_url,
            ns_id,
            attempts,
            oauth_export_by_path,
        )
        if text:
            return text, via, attempts

    # 1) fileid_gid
    if file_id_gid:
        text = await oauth_export_by_path(file_id_gid, f"path={file_id_gid}")
        if text:
            return text, f"files/export {file_id_gid}", attempts

    # 2) Paper API (view_id = doc_id)
    paper_text = await _try_paper_docs_download(
        client, token_ref, refresh, view_id, content_access_token, ns_id, attempts
    )
    if paper_text:
        return paper_text, f"paper/docs/download:{view_id}", attempts

    # 3) view_id を files API の id として get_metadata → export
    for ref in (f"id:{view_id}", view_id):
        for skip_ns in (True, False):
            md = await _files_get_metadata_refreshed(
                client, token_ref, refresh, ref, ns_id, skip_ns=skip_ns
            )
            if not isinstance(md, dict):
                continue
            export_ref = _export_ref_from_metadata(md)
            if not export_ref:
                continue
            attempts.append(
                _attempt_log(f"view_id metadata ref={export_ref}", 200, md.get("name") or "")
            )
            text = await oauth_export_by_path(
                export_ref, f"path={export_ref} (view_id metadata)"
            )
            if text:
                return text, f"files/export {export_ref}", attempts

    # 4) ファイル名検索 → 取引先ツリー走査 → view_id 照合 → export
    if file_name:
        matched_path, direct_text = await _find_path_by_view_id_scan(
            client,
            token_ref,
            refresh,
            view_id,
            file_name,
            ns_id,
            attempts,
            oauth_export_by_path,
        )
        if direct_text:
            return direct_text, f"files/export {matched_path} (name match)", attempts
        if matched_path:
            text = await oauth_export_by_path(
                matched_path, f"path={matched_path} (view_id scan)"
            )
            if text:
                return text, f"files/export {matched_path} (view_id scan)", attempts

        matched_path, direct_text = await _browse_client_tree_for_paper(
            client,
            token_ref,
            refresh,
            file_name,
            view_id,
            ns_id,
            attempts,
            oauth_export_by_path,
        )
        if direct_text:
            return direct_text, f"files/export {matched_path} (client tree)", attempts

    logger.warning(
        "paper shortcut export failed view_id=%s file_name=%s attempts=%s",
        view_id,
        file_name,
        attempts,
    )
    return None, None, attempts
