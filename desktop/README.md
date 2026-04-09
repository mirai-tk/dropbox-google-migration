# Paper Migrator — macOS デスクトップ（PyInstaller）

## 前提

- Python 3.11+（このリポジトリでは **pyenv で 3.12.6** を使う想定の手順例があります。別バージョンでも可）
- Node.js（UI ビルド用）
- Google / Dropbox の OAuth クレデンシャル（`source/.env` / `desktop/.env` / **リポジトリ直下の `.env`** のいずれか。Python は未設定の変数だけ順に読み込みます）

## セットアップ

```bash
cd desktop
# pyenv（例: 3.12.6）— 未インストールなら先に: pyenv install 3.12.6
pyenv local 3.12.6
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# PyInstaller は同じ venv で: pip install pyinstaller
```

`pyenv` を使わない場合は、上の `pyenv local` の代わりに使いたい `python3` で `python3 -m venv .venv` としてください。

リポジトリ**ルート**の `Makefile` でも同じことができます。`make help` で一覧。例: `make source-install` → `make source-build-desktop`（UI）→ `make desktop-setup` → `make desktop-run`。Apple Silicon の作り直しは `make desktop-setup-arm64`（`PYENV_VERSION` は既定 `3.12.6`、上書き可）。

**fish を使う場合:** `source .venv/bin/activate` は bash 用なのでエラーになります。代わりに `source .venv/bin/activate.fish` を使うか、有効化せず `.venv/bin/pip` / `.venv/bin/python` をフルパスで実行してください。

### Apple Silicon で `incompatible architecture`（pydantic_core など）

`have 'arm64', need 'x86_64'` のように **CPU アーキテクチャが合わない**と、`.venv` 内の拡張モジュールが読み込めません。原因はだいたい次のどちらかです。

- **`.venv` を arm64 用に `pip install` したのに、Rosetta 有効のターミナルで x86_64 の `python` を動かしている**
- 逆に、x86_64 用 venv を arm64 の Python で動かしている

**対処:** `desktop` で venv を作り直し、**CPU アーキテクチャを実行時と一致**させてください。Apple Silicon で「arm64 用に入れたパッケージ」を使うなら、**Rosetta をオフのターミナル**で動かすか、venv 作成時に明示します。

```bash
cd desktop
rm -rf .venv
# pyenv で 3.12.6 などを有効にしたうえで（例: pyenv local 3.12.6）、arm64 で venv 作成:
arch -arm64 "$(pyenv which python)" -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run_desktop.py
```

Cursor の統合ターミナルが Rosetta のときは、**ターミナルプロファイルを arm64 にする**か、上記のように **`arch -arm64` で venv を作り、起動も常に arm64 側の Python** に揃えてください。`run_desktop.py` はこの種のエラーを検出すると、標準エラーに短い手順を出します。

## UI のビルド（デスクトップ用）

リポジトリルートまたは `source` で:

```bash
cp source/.env.desktop.example source/.env.desktop
# .env.desktop に VITE_* を記入（.env と同様）

npm run build:desktop --prefix source
```

`source/dist` が生成されます。

## アプリの起動（開発）

OAuth 用の秘密は `source/.env`（または `desktop/.env`）に書いておけば、`app/config.py` が起動時に読み込みます（シェルで `export` しなくても構いません）。

```bash
cd desktop
source .venv/bin/activate          # fish なら: source .venv/bin/activate.fish
python run_desktop.py
```

`desktop/.venv` を一度作って `pip install -r requirements.txt` 済みなら、`python3 run_desktop.py` のように **activate していないシステム Python** で叩いても、`run_desktop.py` が **同じ venv の Python に自動で付け替え**（`os.execv`）します。

**まだ `.venv` が無い、または venv 内に keyring が入っていない**場合は従来どおりエラーになります。`cd desktop` して venv を有効化するか、ルートからなら `desktop/.venv/bin/python desktop/run_desktop.py` のように **venv の `python` を明示**してください。

アプリ全体のログは既定で **`desktop/logs/app_latest.log`**（ローテーション付き）に出力されます。起動時に `_latest.log` が既にあれば、前回分を **`desktop/logs/log_YYYYMMDD_HHMMSS.log`** にリネームしてから書き込みます。より詳細な DEBUG（マイグレーション／Paper 調査用）にする場合は `python run_desktop.py --dev`、または `.env` に `PAPER_MIGRATOR_DEV=1`。パスを変えるときは環境変数 `PAPER_MIGRATOR_LOG_FILE`（`*_latest.log` で終わるパスなら同様に起動時退避します）。

ブラウザではなく **pywebview** のウィンドウが開き、`127.0.0.1:8765` で FastAPI が UI と `/api/*` を提供します。

## OAuth コンソール設定

Google Cloud の OAuth クライアントでは、次の **2 種類の欄** を混同しないでください（「無効な生成元」と出るのは、多くの場合 **パス付き URL を JavaScript 生成元に入れている**ときです）。

### 承認済みの JavaScript 生成元

- **スキーム + ホスト + ポートだけ**（**パスは付けない**。**末尾も `/` にしない**）
- 例: `http://127.0.0.1:8765`（`run_desktop.py` のデフォルトポート。`--port` を変えたら数字も合わせる）
- `http://127.0.0.1:8765/` や `http://127.0.0.1:8765/api/...` は **ここには入れない**

### 承認済みのリダイレクト URI

- **フル URL（パス付き可）**。OAuth コールバック専用の欄です。

**Google（デスクトップ）** — 次を **リダイレクト URI** に追加:

`http://127.0.0.1:8765/api/oauth/google/callback`

**Dropbox（デスクトップ）** — 次を **リダイレクト URI** に追加:

`http://127.0.0.1:8765/api/oauth/dropbox/callback`

`localhost` と `127.0.0.1` は別扱いです。普段アプリを開くホストに合わせて登録してください。

## アップデート確認（デスクトップ）

起動時にバックエンドがリモートと照合し、新しいバージョンがあればサイドバーに案内を表示します（**ダウンロードページをブラウザで開く**方式。アプリ内での自動インストールは行いません）。

1. **バージョン**は `desktop/app/version.py` の `APP_VERSION`（リリース時に `source/package.json` の `version` と揃えるとよいです）。
2. **確認先**は次のどちらかを `desktop/.env` またはリポジトリ直下の `.env` に設定します（`config.py` が起動時に読み込みます）。

- **`APP_UPDATE_MANIFEST_URL`** … HTTPS で配布する JSON の URL（優先）。例:

```json
{
  "latest_version": "1.0.1",
  "download_url": "https://example.com/releases/app.dmg",
  "release_notes": "任意の説明"
}
```

- **`GITHUB_RELEASES_REPO`** … `owner/repo` 形式。GitHub API の `releases/latest` と `tag_name`（先頭の `v` は無視）を比較し、`.dmg` / `.zip` の browser download URL があればそれを開き、なければリリースページの URL を開きます。

両方未設定のときは「確認先が未設定」と表示され、更新の有無は判定しません。

## PyInstaller で .app を作る

```bash
cd desktop
source .venv/bin/activate          # fish なら: source .venv/bin/activate.fish
pip install pyinstaller
pyinstaller paper-migrator.spec
```

成果物は `dist/Paper Migrator Biz.app`（spec 内の名前に依存）。

## トークン保存

ログイン後、フロントが `/api/session/sync` を呼び、macOS では **キーチェーン**（`keyring`）に refresh token 等を保存します。

## ネイティブ移行エンジン
 
`VITE_USE_NATIVE_ENGINE=true`（デスクトップビルドで既定）のとき、フォルダ一括移行は **Python** の `/api/engine/migrate`（NDJSON ストリーム）で実行されます。並列 5、約 50 ファイルごとに `gc.collect()` を実行します。

## WebView での認証確認（GSI / Dropbox PKCE）

配布前に **実機の .app** で次を確認してください。

1. Google: サイドバーから「Google に接続」→ ポップアップまたはリダイレクトでコード取得 → ドライブ一覧が表示されること。
2. Dropbox: PKCE でブラウザ／WebView が `http://127.0.0.1:<port>/?code=...` に戻り、Dropbox ツリーが表示されること。
3. いずれかが失敗する場合: コンソール（開発ビルド）と Google / Dropbox のリダイレクト URI 登録を再確認。Cookie サードパーティ制限は通常ローカルオリジンでは問題になりにくいが、ブロック時は公式クライアント ID・スコープを確認すること。
