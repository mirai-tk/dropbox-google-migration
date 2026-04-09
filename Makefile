# Dropbox → Google 移行ツール — よく使うコマンド
# macOS / bash 想定（pyenv + desktop/.venv）

SHELL := /bin/bash
.DEFAULT_GOAL := help

DESKTOP := desktop
SOURCE  := source
PYENV_VERSION ?= 3.12.6
# PYENV_VERSION を空にすると `pyenv local` をスキップ（システムの python を使用）

.PHONY: help desktop-setup desktop-setup-arm64 desktop-run desktop-dev \
	desktop-build-ui desktop-clean-venv desktop-pyinstaller \
	source-install source-build source-build-desktop source-dev source-dev-desktop source-preview

help:
	@echo "使い方（リポジトリルートで実行）"
	@echo ""
	@echo "【source / フロント（Vite）】"
	@echo "  make source-install        npm install（source/）"
	@echo "  make source-build          npm run build — ブラウザ向け dist"
	@echo "  make source-build-desktop  npm run build:desktop — デスクトップ用 dist"
	@echo "  make source-dev            npm run dev — 開発サーバ"
	@echo "  make source-dev-desktop    npm run dev:desktop"
	@echo "  make source-preview        npm run preview"
	@echo ""
	@echo "【desktop / Python】"
	@echo "  make desktop-setup        pyenv local $(PYENV_VERSION) → .venv 作成（無いときだけ）→ pip install"
	@echo "  make desktop-setup-arm64  Apple Silicon で venv を arm64 付きで作り直し（Rosetta 問題のとき）"
	@echo "  make desktop-run          デスクトップアプリ起動"
	@echo "  make desktop-dev          同上 --dev（詳細ログ）"
	@echo "  make desktop-build-ui     source-build-desktop と同じ（エイリアス）"
	@echo "  make desktop-clean-venv   desktop/.venv を削除"
	@echo "  make desktop-pyinstaller  PyInstaller で .app ビルド（要: pip install 済み venv）"
	@echo ""
	@echo "変数: PYENV_VERSION=$(PYENV_VERSION) （空にすると pyenv local しない）"

# --- desktop Python venv ---

desktop-setup:
ifeq ($(strip $(PYENV_VERSION)),)
	cd $(DESKTOP) && (test -d .venv || python3 -m venv .venv) && .venv/bin/pip install -r requirements.txt
else
	cd $(DESKTOP) && pyenv local $(PYENV_VERSION) && (test -d .venv || python -m venv .venv) && .venv/bin/pip install -r requirements.txt
endif

desktop-setup-arm64:
ifeq ($(strip $(PYENV_VERSION)),)
	@echo "PYENV_VERSION が空のときは手動で python を指定してください。" >&2
	@exit 1
endif
	cd $(DESKTOP) && rm -rf .venv && pyenv local $(PYENV_VERSION) && arch -arm64 "$$(pyenv which python)" -m venv .venv && .venv/bin/pip install -r requirements.txt

desktop-run:
	cd $(DESKTOP) && .venv/bin/python run_desktop.py

desktop-dev:
	cd $(DESKTOP) && .venv/bin/python run_desktop.py --dev

desktop-clean-venv:
	rm -rf $(DESKTOP)/.venv

# --- source / frontend (npm --prefix source) ---

source-install:
	npm install --prefix $(SOURCE)

source-build:
	npm run build --prefix $(SOURCE)

source-build-desktop:
	npm run build:desktop --prefix $(SOURCE)

source-dev:
	npm run dev --prefix $(SOURCE)

source-dev-desktop:
	npm run dev:desktop --prefix $(SOURCE)

source-preview:
	npm run preview --prefix $(SOURCE)

# 後方互換・短い名前
desktop-build-ui: source-build-desktop

# --- package ---

desktop-pyinstaller:
	cd $(DESKTOP) && .venv/bin/pip install pyinstaller && .venv/bin/pyinstaller paper-migrator.spec
