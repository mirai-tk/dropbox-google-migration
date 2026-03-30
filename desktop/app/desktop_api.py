"""pywebview 用 JS ブリッジ: WebView 内では blob ダウンロードが効かないためネイティブ保存を使う。"""
from __future__ import annotations

import base64
import logging

import webview

logger = logging.getLogger(__name__)


class DesktopApi:
    def save_download(self, filename: str, data_base64: str) -> bool:
        """
        保存ダイアログを開き、base64 デコードしたバイト列を書き込む。
        :param filename: 提案ファイル名（例: note.docx）
        :param data_base64: ファイル内容（Base64）
        :return: 保存したら True、キャンセルまたは失敗なら False
        """
        win = webview.windows[0] if webview.windows else None
        if not win:
            logger.error("save_download: no webview window")
            return False
        try:
            raw = base64.b64decode(data_base64)
        except Exception:
            logger.exception("save_download: base64 decode failed")
            return False
        try:
            result = win.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=filename or "download",
            )
        except Exception:
            logger.exception("save_download: dialog failed")
            return False
        if not result:
            return False
        path = result[0] if isinstance(result, (tuple, list)) else result
        try:
            with open(path, "wb") as f:
                f.write(raw)
        except OSError:
            logger.exception("save_download: write failed")
            return False
        return True
