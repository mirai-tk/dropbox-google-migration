"""Load OAuth secrets from environment (never embed in frontend)."""
import os
import sys
from pathlib import Path


def _load_dotenv_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


# Repo root = parent of desktop/
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def repo_root() -> Path:
    """リポジトリルート（desktop/ の親）。"""
    return _REPO_ROOT


_load_dotenv_file(_REPO_ROOT / "source" / ".env")
_load_dotenv_file(_REPO_ROOT / "desktop" / ".env")
# リポジトリ直下の .env（未設定のキーのみ補完。多くの環境でここに VITE_* を置く）
_load_dotenv_file(_REPO_ROOT / ".env")


def get_settings():
    return {
        "google_client_id": os.environ.get("VITE_GOOGLE_CLIENT_ID", ""),
        "google_client_secret": os.environ.get("VITE_GOOGLE_CLIENT_SECRET", ""),
        "dropbox_app_key": os.environ.get("VITE_DROPBOX_APP_KEY", ""),
        "dropbox_app_secret": os.environ.get("VITE_DROPBOX_APP_SECRET", ""),
    }


def dist_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "static"
    return _REPO_ROOT / "source" / "dist"


def migration_resume_checkpoints_enabled() -> bool:
    """1GB+ のディスクレジューム（チェックポイント）を使うか。

    無効にするとレジューム関連のコードパスに入らず、追加前の転送挙動に近い。
    環境変数 ENABLE_MIGRATION_RESUME_CHECKPOINTS: 既定 1。0 / false / no / off でオフ。
    """
    v = os.environ.get("ENABLE_MIGRATION_RESUME_CHECKPOINTS", "1").strip().lower()
    return v not in ("0", "false", "no", "off")

