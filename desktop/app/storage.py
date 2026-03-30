"""Persist OAuth tokens locally (Keychain on macOS via keyring)."""
import json
import keyring

SERVICE = "paper-migrator-biz"


def _blob_key(name: str) -> str:
    return f"{SERVICE}:{name}"


def save_tokens(
    google_access: str | None = None,
    google_refresh: str | None = None,
    dropbox_access: str | None = None,
    dropbox_refresh: str | None = None,
    dropbox_ns_id: str | None = None,
) -> None:
    data = {}
    if google_access is not None:
        data["google_access"] = google_access
    if google_refresh is not None:
        data["google_refresh"] = google_refresh
    if dropbox_access is not None:
        data["dropbox_access"] = dropbox_access
    if dropbox_refresh is not None:
        data["dropbox_refresh"] = dropbox_refresh
    if dropbox_ns_id is not None:
        data["dropbox_ns_id"] = dropbox_ns_id

    existing = load_all()
    existing.update({k: v for k, v in data.items() if v is not None})
    keyring.set_password(SERVICE, "oauth", json.dumps(existing))


def strip_keys_from_keyring(keys: tuple[str, ...]) -> None:
    """Remove given keys from the OAuth Keychain blob (used for migration / cleanup)."""
    existing = load_all()
    changed = False
    for k in keys:
        if k in existing:
            del existing[k]
            changed = True
    if not changed:
        return
    if not existing:
        try:
            keyring.delete_password(SERVICE, "oauth")
        except keyring.errors.PasswordDeleteError:
            pass
    else:
        keyring.set_password(SERVICE, "oauth", json.dumps(existing))


def load_all() -> dict:
    raw = keyring.get_password(SERVICE, "oauth")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def clear() -> None:
    try:
        keyring.delete_password(SERVICE, "oauth")
    except keyring.errors.PasswordDeleteError:
        pass


def clear_google_keys() -> None:
    existing = load_all()
    if not existing:
        return
    for k in ("google_access", "google_refresh"):
        existing.pop(k, None)
    if not existing:
        clear()
    else:
        keyring.set_password(SERVICE, "oauth", json.dumps(existing))


def clear_dropbox_keys() -> None:
    existing = load_all()
    if not existing:
        return
    for k in ("dropbox_access", "dropbox_refresh", "dropbox_ns_id"):
        existing.pop(k, None)
    if not existing:
        clear()
    else:
        keyring.set_password(SERVICE, "oauth", json.dumps(existing))
