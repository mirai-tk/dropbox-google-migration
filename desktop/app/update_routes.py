"""アプリバージョン、アップデート確認、メモリ診断 API。"""
from fastapi import APIRouter

from . import update_check
from . import memory_info
from .version import APP_VERSION

router = APIRouter(prefix="/api/app", tags=["app"])

MEMORY_HINT = (
    "RSS は Python のヒープや OS のページキャッシュの影響で、"
    "Dropbox のダウンロードバッファが解放されてもすぐ数値が下がらないことがあります。"
    "移行処理では定期的に gc.collect() も実行しています。"
)


@router.get("/version")
async def app_version():
    return {
        "version": APP_VERSION,
        "update_check_configured": update_check.is_update_source_configured(),
    }


@router.get("/shell")
async def app_shell():
    """この FastAPI がデスクトップシェルか（OAuth 経路を JS が選ぶため）。"""
    return {"desktop": True}


@router.get("/update-check")
async def update_check_endpoint():
    return await update_check.check_for_updates()


@router.get("/memory")
async def app_memory():
    snap = memory_info.process_memory_snapshot()
    snap["hint"] = MEMORY_HINT
    return snap


@router.post("/memory/gc")
async def app_memory_gc():
    """手動で gc.collect() を試し、前後の RSS を返す（診断用）。"""
    return memory_info.run_gc_and_snapshot()
