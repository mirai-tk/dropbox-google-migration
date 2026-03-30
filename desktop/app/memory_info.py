"""プロセスのメモリ使用量（デスクトップの診断用）。"""
from __future__ import annotations

import gc
from typing import Any

import psutil


def process_memory_snapshot() -> dict[str, Any]:
    p = psutil.Process()
    mi = p.memory_info()
    rss = int(mi.rss)
    vms = int(getattr(mi, "vms", 0))
    # macOS 等で VMS が極端に大きく出ることがあり、RSS 比で異常なら省略
    vms_mb: float | None = round(vms / (1024 * 1024), 1)
    if vms > rss * 1000 or (vms_mb is not None and vms_mb > 1_000_000):
        vms_mb = None
    out: dict[str, Any] = {
        "rss_bytes": rss,
        "rss_mb": round(rss / (1024 * 1024), 1),
        "gc_counts": list(gc.get_count()),
    }
    if vms_mb is not None:
        out["vms_bytes"] = vms
        out["vms_mb"] = vms_mb
    return out


def run_gc_and_snapshot() -> dict[str, Any]:
    before = process_memory_snapshot()
    collected = gc.collect()
    after = process_memory_snapshot()
    return {
        "collected_objects": collected,
        "before_rss_mb": before["rss_mb"],
        "after_rss_mb": after["rss_mb"],
        "delta_rss_mb": round(after["rss_mb"] - before["rss_mb"], 2),
        "after": after,
    }
