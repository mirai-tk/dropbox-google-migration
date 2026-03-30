"""マイグレーション中の認証失敗（リフレッシュ不可）で処理を打ち切るための例外。"""


class MigrationAuthError(Exception):
    """Google / Dropbox のいずれかで 401 が解消できないときに送出する。"""
