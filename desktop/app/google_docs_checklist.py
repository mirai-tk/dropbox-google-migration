"""DOCX→GDoc 後、☐/☑ マーカーを Google Docs API のネイティブチェックリスト（BULLET_CHECKBOX）にする。

☑ 行は API が箇条書きの「チェック済み」状態を設定できないため、ラベルに取り消し線を付ける。
source/src/utils/googleDocsChecklist.js と同じ方針。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from .google_oauth_refresh import google_request_with_token_refresh

logger = logging.getLogger(__name__)

UNCHECKED = "\u2610"
CHECKED = "\u2611"

# Google Docs API が GCP で無効（SERVICE_DISABLED）のとき、全ファイルで同じ 403 が繰り返されるのを防ぐ
_docs_api_unavailable: bool = False


def _is_docs_api_service_disabled(status_code: int, body: str) -> bool:
    if status_code != 403:
        return False
    try:
        data = json.loads(body)
        err = data.get("error") or {}
        for d in err.get("details") or []:
            if d.get("reason") == "SERVICE_DISABLED":
                return True
        msg = (err.get("message") or "").lower()
        if "docs.googleapis.com" in msg and "disabled" in msg:
            return True
    except (json.JSONDecodeError, TypeError):
        pass
    return False


# 先頭インデント・☐/☑ 直後の区切り（GDoc が NBSP / 全角スペースにすることがある）
_TASK_MARKER_LINE = re.compile(
    r"^([\t \u00a0\u2009\u3000]*)([\u2610\u2611])([ \u00a0\n\r\t\u2009\u3000])"
)


def _utf16_len(s: str) -> int:
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def _map_utf16_offset_to_document_index(
    elems: list[dict[str, Any]], utf16_off: int
) -> int | None:
    u = 0
    for e in elems:
        tr = e.get("textRun") or {}
        content = tr.get("content") or ""
        if not content:
            continue
        n = _utf16_len(content)
        if utf16_off < u + n:
            si = e.get("startIndex")
            if si is None:
                return None
            return si + (utf16_off - u)
        u += n
    return None


def _flatten_paragraph_structural_elements(
    elements: list | None, out: list[dict[str, Any]]
) -> None:
    if not elements:
        return
    for el in elements:
        if "paragraph" in el:
            out.append(el)
        elif "table" in el:
            for row in (el.get("table") or {}).get("tableRows") or []:
                for cell in row.get("tableCells") or []:
                    _flatten_paragraph_structural_elements(cell.get("content"), out)


async def convert_task_markers_to_native_checklists(
    client: httpx.AsyncClient,
    token_ref: list[str],
    refresh: str | None,
    document_id: str,
) -> bool:
    global _docs_api_unavailable

    if not document_id or not token_ref or not token_ref[0]:
        return False
    if _docs_api_unavailable:
        return False

    r = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.get(
            f"https://docs.googleapis.com/v1/documents/{document_id}",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=120.0,
        ),
    )
    if not r.is_success:
        body = r.text or ""
        if _is_docs_api_service_disabled(r.status_code, body):
            if not _docs_api_unavailable:
                _docs_api_unavailable = True
                logger.warning(
                    "Google Docs API が GCP プロジェクトで無効のため、チェックリストのネイティブ化をスキップします。"
                    " コンソールで「Google Docs API」を有効化してください: "
                    "https://console.developers.google.com/apis/library/docs.googleapis.com"
                )
            return False
        logger.warning(
            "documents.get failed status=%s body=%s",
            r.status_code,
            body[:2000],
        )
        return False

    doc: dict[str, Any] = r.json()
    structural_flat: list[dict[str, Any]] = []
    _flatten_paragraph_structural_elements(doc.get("body", {}).get("content"), structural_flat)

    candidates: list[dict[str, int]] = []
    checked_paragraph_indices: list[int] = []

    for j, el in enumerate(structural_flat):
        p = el.get("paragraph") or {}
        elems = p.get("elements") or []
        if not elems:
            continue
        text = "".join(
            (e.get("textRun") or {}).get("content") or "" for e in elems
        )
        m = _TASK_MARKER_LINE.match(text)
        if not m:
            continue
        marker = m.group(2)
        marker_start_cp = m.start(2)
        utf16_off = _utf16_len(text[:marker_start_cp])
        delete_len = 2
        first_idx = _map_utf16_offset_to_document_index(elems, utf16_off)
        se_end = el.get("endIndex")
        if first_idx is None or se_end is None:
            continue
        if se_end - first_idx <= delete_len:
            continue
        candidates.append(
            {"firstIdx": first_idx, "seEnd": se_end, "deleteLen": delete_len}
        )
        if marker == CHECKED:
            checked_paragraph_indices.append(j)

    if not candidates:
        return True

    candidates.sort(key=lambda c: c["firstIdx"], reverse=True)
    requests: list[dict[str, Any]] = []
    for c in candidates:
        fi, se_end, dl = c["firstIdx"], c["seEnd"], c["deleteLen"]
        requests.append(
            {
                "deleteContentRange": {
                    "range": {"startIndex": fi, "endIndex": fi + dl},
                }
            }
        )
        requests.append(
            {
                "createParagraphBullets": {
                    "range": {"startIndex": fi, "endIndex": se_end - dl},
                    "bulletPreset": "BULLET_CHECKBOX",
                }
            }
        )

    br = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            f"https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            json={"requests": requests},
            timeout=120.0,
        ),
    )
    if not br.is_success:
        berr = br.text or ""
        if _is_docs_api_service_disabled(br.status_code, berr):
            if not _docs_api_unavailable:
                _docs_api_unavailable = True
                logger.warning(
                    "Google Docs API が GCP プロジェクトで無効のため、チェックリストのネイティブ化をスキップします。"
                    " コンソールで「Google Docs API」を有効化してください: "
                    "https://console.developers.google.com/apis/library/docs.googleapis.com"
                )
            return False
        logger.warning(
            "documents.batchUpdate failed status=%s body=%s",
            br.status_code,
            berr[:2000],
        )
        return False

    if not checked_paragraph_indices:
        return True

    r2 = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.get(
            f"https://docs.googleapis.com/v1/documents/{document_id}",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=120.0,
        ),
    )
    if not r2.is_success:
        logger.warning(
            "documents.get (after checklist) failed status=%s body=%s",
            r2.status_code,
            (r2.text or "")[:2000],
        )
        return True

    doc2: dict[str, Any] = r2.json()
    structural_flat2: list[dict[str, Any]] = []
    _flatten_paragraph_structural_elements(
        doc2.get("body", {}).get("content"), structural_flat2
    )
    if len(structural_flat2) != len(structural_flat):
        logger.warning(
            "paragraph count changed after checklist batch; skip strikethrough for checked tasks"
        )
        return True

    strike_requests: list[dict[str, Any]] = []
    for idx in checked_paragraph_indices:
        el = structural_flat2[idx]
        p = el.get("paragraph") or {}
        elems = p.get("elements") or []
        if not elems:
            continue
        start_idx = elems[0].get("startIndex")
        end_idx = elems[-1].get("endIndex")
        if start_idx is None or end_idx is None or end_idx <= start_idx:
            continue
        strike_requests.append(
            {
                "updateTextStyle": {
                    "range": {"startIndex": start_idx, "endIndex": end_idx},
                    "textStyle": {"strikethrough": True},
                    "fields": "strikethrough",
                }
            }
        )
    if not strike_requests:
        return True

    sr = await google_request_with_token_refresh(
        client,
        token_ref,
        refresh,
        lambda tok: client.post(
            f"https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            json={"requests": strike_requests},
            timeout=120.0,
        ),
    )
    if not sr.is_success:
        logger.warning(
            "documents.batchUpdate (strikethrough) failed status=%s body=%s",
            sr.status_code,
            (sr.text or "")[:2000],
        )
    return True
