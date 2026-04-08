"""FastAPI app: static UI + OAuth + session + engine."""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import dist_dir
from .logging_config import attach_uvicorn_memory_poll_suppressor, configure_app_logging
from .dropbox_oauth_routes import router as dropbox_oauth_router
from .google_oauth_routes import router as google_oauth_router
from .engine_routes import router as engine_router
from .oauth_routes import router as oauth_router
from .proxy_routes import router as proxy_router
from .session_routes import router as session_router
from .update_routes import router as update_router

logger = logging.getLogger(__name__)


def create_app(static_root: Path | None = None) -> FastAPI:
    configure_app_logging()
    root = static_root or dist_dir()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # uvicorn がロギングを初期化した後に付ける（メモリ API のポーリング行をターミナルに出さない）
        attach_uvicorn_memory_poll_suppressor()
        yield

    app = FastAPI(title="Paper Migrator Desktop", lifespan=lifespan)

    app.include_router(oauth_router)
    app.include_router(dropbox_oauth_router)
    app.include_router(google_oauth_router)
    app.include_router(session_router)
    app.include_router(update_router)
    app.include_router(engine_router)
    app.include_router(proxy_router)

    if root.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=root / "assets"),
            name="assets",
        )

    index = root / "index.html"

    @app.get("/")
    async def index_root():
        if index.is_file():
            return FileResponse(index)
        return {"detail": "Build UI first: npm run build --prefix source"}

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            return {"detail": "Not Found"}
        if (root / full_path).is_file():
            return FileResponse(root / full_path)
        if index.is_file():
            return FileResponse(index)
        return {"detail": "Build UI first: npm run build --prefix source"}

    return app
