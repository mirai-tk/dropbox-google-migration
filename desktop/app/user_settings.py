"""Non-sensitive UI state: JSON file under user config dir (not Keychain)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

APP_DIR_NAME = "paper-migrator"

# Keys stored in settings.json (also legacy names that were in Keychain)
UI_KEYS = ("dropbox_current_path", "gdrive_browser_path", "gdrive_selected_folder_id")


def user_config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return Path(base) / APP_DIR_NAME if base else Path.home() / APP_DIR_NAME
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / APP_DIR_NAME
    return Path.home() / ".config" / APP_DIR_NAME


def settings_path() -> Path:
    return user_config_dir() / "settings.json"


def _write_atomic(data: dict) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(path)


def migrate_legacy_ui_keys_from_keyring() -> None:
    """One-time: copy UI keys from Keychain blob into settings.json and strip them from Keychain."""
    from . import storage

    data = storage.load_all()
    to_move = {k: data[k] for k in UI_KEYS if k in data and data[k] is not None}
    if not to_move:
        return
    current: dict = {}
    path = settings_path()
    if path.is_file():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
    merged = {**current, **to_move}
    _write_atomic(merged)
    storage.strip_keys_from_keyring(UI_KEYS)


def load_settings() -> dict:
    migrate_legacy_ui_keys_from_keyring()
    path = settings_path()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_settings_merge(
    dropbox_current_path: str | None = None,
    gdrive_browser_path: str | None = None,
    gdrive_selected_folder_id: str | None = None,
) -> None:
    updates = {}
    if dropbox_current_path is not None:
        updates["dropbox_current_path"] = dropbox_current_path
    if gdrive_browser_path is not None:
        updates["gdrive_browser_path"] = gdrive_browser_path
    if gdrive_selected_folder_id is not None:
        updates["gdrive_selected_folder_id"] = gdrive_selected_folder_id
    if not updates:
        return
    current = load_settings()
    current.update(updates)
    _write_atomic(current)


def clear_all() -> None:
    path = settings_path()
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass


def clear_google_paths() -> None:
    current = load_settings()
    for k in ("gdrive_browser_path", "gdrive_selected_folder_id"):
        current.pop(k, None)
    if not current:
        clear_all()
    else:
        _write_atomic(current)


def clear_dropbox_path() -> None:
    current = load_settings()
    current.pop("dropbox_current_path", None)
    if not current:
        clear_all()
    else:
        _write_atomic(current)
