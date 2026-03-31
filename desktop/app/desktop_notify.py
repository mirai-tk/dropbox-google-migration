"""OS ネイティブのデスクトップ通知（マイグレーション完了等）。"""
from __future__ import annotations

import base64
import logging
import shutil
import subprocess
import sys

logger = logging.getLogger(__name__)


def _escape_osascript(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def show_desktop_notification(title: str, body: str) -> None:
    """
    非ブロッキングに近い通知（失敗しても例外は握りつぶす）。
    migrate 完了などから asyncio.to_thread で呼ぶ想定。
    """
    title = (title or "").replace("\n", " ").strip() or "通知"
    body = (body or "").replace("\n", " ").strip() or ""
    plat = sys.platform
    try:
        if plat == "darwin":
            subprocess.run(
                [
                    "osascript",
                    "-e",
                    f'display notification "{_escape_osascript(body)}" '
                    f'with title "{_escape_osascript(title)}"',
                ],
                check=False,
                timeout=15,
                capture_output=True,
            )
            return
        if plat.startswith("linux"):
            notify_send = shutil.which("notify-send")
            if notify_send:
                subprocess.run(
                    [notify_send, "-a", "Paper Migrator", title, body],
                    check=False,
                    timeout=15,
                    capture_output=True,
                )
            else:
                logger.debug("notify-send not found; skipping desktop notification")
            return
        if plat == "win32":
            # System.Windows.Forms.NotifyIcon のバルーン（追加依存なし）
            t_b64 = base64.b64encode(title.encode("utf-8")).decode("ascii")
            b_b64 = base64.b64encode(body.encode("utf-8")).decode("ascii")
            ps = (
                "$t = [System.Text.Encoding]::UTF8.GetString("
                f"[System.Convert]::FromBase64String('{t_b64}'));\n"
                "$b = [System.Text.Encoding]::UTF8.GetString("
                f"[System.Convert]::FromBase64String('{b_b64}'));\n"
                "Add-Type -AssemblyName System.Windows.Forms;\n"
                "Add-Type -AssemblyName System.Drawing;\n"
                "$ni = New-Object System.Windows.Forms.NotifyIcon;\n"
                "$ni.Icon = [System.Drawing.SystemIcons]::Information;\n"
                "$ni.Visible = $true;\n"
                "$ni.ShowBalloonTip(8000, $t, $b, [System.Windows.Forms.ToolTipIcon]::Info);\n"
            )
            subprocess.run(
                ["powershell", "-NoProfile", "-STA", "-Command", ps],
                check=False,
                timeout=20,
                capture_output=True,
            )
            return
        logger.debug("desktop notification: unsupported platform %s", plat)
    except Exception:
        logger.debug("desktop notification failed", exc_info=True)
