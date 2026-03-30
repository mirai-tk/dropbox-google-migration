"""リモートと照らしてアップデートの有無を判定（URL は環境変数で指定、クライアントからは指定不可）。"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from .version import APP_VERSION

_GITHUB_UA = "PaperMigrator-Desktop-UpdateCheck/1.0"


def _parse_version_tuple(s: str) -> tuple[int, ...]:
    s = s.strip().lstrip("vV")
    nums = [int(x) for x in re.findall(r"\d+", s)]
    return tuple(nums) if nums else (0,)


def _is_newer(remote: str, current: str) -> bool:
    return _parse_version_tuple(remote) > _parse_version_tuple(current)


def _manifest_url() -> str:
    return os.environ.get("APP_UPDATE_MANIFEST_URL", "").strip()


def _github_repo() -> str:
    return os.environ.get("GITHUB_RELEASES_REPO", "").strip()


def is_update_source_configured() -> bool:
    return bool(_manifest_url() or _github_repo())


async def _fetch_json(url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        r = await client.get(
            url,
            headers={"User-Agent": _GITHUB_UA, "Accept": "application/json"},
        )
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            raise ValueError("manifest must be a JSON object")
        return data


async def _fetch_github_release(owner: str, repo: str) -> dict[str, Any]:
    url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        r = await client.get(
            url,
            headers={
                "User-Agent": _GITHUB_UA,
                "Accept": "application/vnd.github+json",
            },
        )
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            raise ValueError("invalid GitHub API response")

    tag = (data.get("tag_name") or "").lstrip("vV")
    body = (data.get("body") or "").strip()
    html_url = data.get("html_url") or ""
    download_url: str | None = None
    for asset in data.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        name = (asset.get("name") or "").lower()
        if name.endswith(".dmg") or name.endswith(".zip"):
            download_url = asset.get("browser_download_url")
            if download_url:
                break
    if not download_url:
        download_url = html_url or None

    return {
        "latest_version": tag,
        "download_url": download_url,
        "release_notes": body,
    }


async def check_for_updates() -> dict[str, Any]:
    current = APP_VERSION
    base: dict[str, Any] = {
        "current_version": current,
        "configured": is_update_source_configured(),
        "update_available": False,
        "latest_version": None,
        "download_url": None,
        "release_notes": None,
        "error": None,
    }

    manifest = _manifest_url()
    gh = _github_repo()

    if not manifest and not gh:
        base["message"] = (
            "アップデート確認先が未設定です。desktop/.env またはリポジトリ直下の .env に "
            "APP_UPDATE_MANIFEST_URL または GITHUB_RELEASES_REPO を設定してください。"
        )
        return base

    try:
        if manifest:
            raw = await _fetch_json(manifest)
            latest = str(raw.get("latest_version") or "").strip()
            dl = raw.get("download_url")
            notes = raw.get("release_notes")
            if not latest:
                raise ValueError("manifest missing latest_version")
            base["latest_version"] = latest
            base["download_url"] = str(dl) if dl else None
            base["release_notes"] = str(notes) if notes else None
        else:
            parts = gh.split("/", 1)
            if len(parts) != 2 or not parts[0] or not parts[1]:
                raise ValueError(
                    "GITHUB_RELEASES_REPO must be owner/repo (e.g. myorg/paper-migrator)"
                )
            info = await _fetch_github_release(parts[0], parts[1])
            base["latest_version"] = info["latest_version"]
            base["download_url"] = info["download_url"]
            base["release_notes"] = info["release_notes"]

        if base["latest_version"] and _is_newer(str(base["latest_version"]), current):
            base["update_available"] = True
    except (httpx.HTTPError, json.JSONDecodeError, ValueError, OSError) as e:
        base["error"] = str(e) or type(e).__name__

    return base
