"""edge-tts 语音合成与音频缓存。"""

from __future__ import annotations

import asyncio
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

import edge_tts

BASE_DIR = Path(__file__).resolve().parent
AUDIO_DIR = BASE_DIR / "data" / "audio"


def audio_filename(segment_id: int, voice: str) -> str:
    safe_voice = voice.replace("/", "_").replace("\\", "_")
    return f"seg{int(segment_id):02d}_{safe_voice}.mp3"


def audio_path(day: date | str, segment_id: int, voice: str) -> Path:
    day_str = day.isoformat() if isinstance(day, date) else str(day)
    return AUDIO_DIR / day_str / audio_filename(segment_id, voice)


def is_ready(day: date | str, segment_id: int, voice: str) -> bool:
    path = audio_path(day, segment_id, voice)
    try:
        return path.exists() and path.stat().st_size > 2000
    except OSError:
        return False


def describe_audio(day: date | str, segment_id: int, voice: str) -> dict:
    path = audio_path(day, segment_id, voice)
    try:
        size = path.stat().st_size
    except OSError:
        return {"ready": False, "size": 0, "seconds": 0}
    # edge-tts 默认输出 24kHz / 48kbps 单声道 mp3，约 6000 bytes/s。
    return {"ready": size > 2000, "size": size, "seconds": round(size / 6000, 1)}


async def _synthesize(text: str, voice: str, out_path: Path, rate: str = "+6%") -> int:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    tmp = out_path.with_suffix(".part")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(tmp, "wb") as fh:
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                fh.write(chunk["data"])
                total += len(chunk["data"])
    if total < 2000:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise RuntimeError("语音合成返回内容过短")
    tmp.replace(out_path)
    return total


def generate_audio(text: str, voice: str, out_path: Path, retries: int = 3) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("语音文本为空")
    if len(text) > 900:
        text = text[:900]
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            size = asyncio.run(_synthesize(text, voice, Path(out_path)))
            return {"path": str(out_path), "size": size, "attempts": attempt + 1}
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < retries - 1:
                import time
                time.sleep(1.0 + attempt * 1.2)
    raise RuntimeError(f"语音合成失败：{last_error}")


def generate_episode_audio(episode: dict, voice: str, progress=None,
                           max_workers: int = 3) -> dict:
    """为一期节目的所有分条生成语音。返回 {segment_id: status}。"""
    segments = episode.get("segments") or []
    day = episode.get("date")
    results: dict[int, dict] = {}
    todo = []
    for seg in segments:
        seg_id = int(seg.get("id") or 0)
        if not seg_id:
            continue
        path = audio_path(day, seg_id, voice)
        if is_ready(day, seg_id, voice):
            results[seg_id] = {"ok": True, "cached": True, **describe_audio(day, seg_id, voice)}
        else:
            todo.append((seg, path))

    total = len(segments)
    done = total - len(todo)
    if progress:
        progress(done, total, None, "")

    def work(seg: dict, path: Path) -> tuple[int, dict]:
        try:
            result = generate_audio(seg.get("narration", ""), voice, path)
            return int(seg["id"]), {"ok": True, "cached": False, **describe_audio(day, seg["id"], voice), "size": result["size"]}
        except Exception as exc:  # noqa: BLE001
            return int(seg["id"]), {"ok": False, "error": str(exc)}

    if todo:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(work, seg, path): int(seg["id"]) for seg, path in todo}
            for fut in as_completed(futures):
                seg_id = futures[fut]
                try:
                    _, status = fut.result()
                except Exception as exc:  # noqa: BLE001
                    status = {"ok": False, "error": str(exc)}
                results[seg_id] = status
                done += 1
                if progress:
                    progress(done, total, seg_id, status.get("error", ""))
    return results
