
from __future__ import annotations

import json
import os
import sys
import traceback
import zipfile
from datetime import date

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

_vendor = os.path.join(BASE, "vendor")
if not os.path.isdir(_vendor) or not os.path.exists(os.path.join(_vendor, "bs4")):
    try:
        os.makedirs(_vendor, exist_ok=True)
        with zipfile.ZipFile(os.path.join(BASE, "vendor.zip")) as zf:
            zf.extractall(_vendor)
    except Exception:
        pass
if _vendor not in sys.path:
    sys.path.insert(1, _vendor)

_js_updater = None
try:
    from js import updateProgress
    _js_updater = updateProgress
except Exception:  # noqa: BLE001
    _js_updater = None


def _progress(message: str) -> None:
    if _js_updater is not None:
        try:
            _js_updater(str(message))
        except Exception:
            pass


def fetch_episode(day_str: str = "", force: bool = False) -> str:
    try:
        import pipeline
        day = date.fromisoformat(day_str) if day_str else None
        data = pipeline.build_episode(day, force=bool(force), progress=_progress)
        return json.dumps(data, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False)


def latest_date() -> str:
    try:
        import pipeline
        return pipeline.latest_available_date().isoformat()
    except Exception as exc:  # noqa: BLE001
        return ""


def build_and_check() -> str:
    """启动时快速检查 Python 模块与依赖是否可用。"""
    try:
        import bs4  # noqa: F401
        import jieba  # noqa: F401
        import requests  # noqa: F401
        import pipeline  # noqa: F401
        return json.dumps({"ok": True}, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": str(exc), "traceback": traceback.format_exc()}, ensure_ascii=False)
