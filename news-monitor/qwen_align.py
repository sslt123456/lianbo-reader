"""Qwen3-ForcedAligner backend.

The model is deliberately loaded lazily: the rest of the desktop app must keep
working (with the small Vosk fallback) when no CUDA/torch/model is available.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("QWEN_ALIGN_MODEL", ROOT / "models" / "Qwen3-ForcedAligner-0.6B"))
FFMPEG = Path(os.environ.get("QWEN_ALIGN_FFMPEG", ROOT / "vendor" / "ffmpeg.exe"))
CACHE_DIR = ROOT / "data" / "align_cache"
MODEL_ID = os.environ.get("QWEN_ALIGN_MODEL_ID", "Qwen/Qwen3-ForcedAligner-0.6B")

_aligner = None
_aligner_error = ""
_load_lock = threading.Lock()
_infer_lock = threading.Lock()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def status() -> dict[str, Any]:
    return {
        "ready": _aligner is not None,
        "loading": _load_lock.locked(),
        "error": _aligner_error,
        "model": str(MODEL_DIR),
        "ffmpeg": str(FFMPEG),
        "cuda": _cuda_available(),
    }


def _cuda_available() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _get_aligner():
    global _aligner, _aligner_error
    if _aligner is not None:
        return _aligner
    with _load_lock:
        if _aligner is not None:
            return _aligner
        try:
            import torch  # type: ignore
            from qwen_asr import Qwen3ForcedAligner  # type: ignore

            if not MODEL_DIR.exists():
                raise RuntimeError(f"模型目录不存在：{MODEL_DIR}")
            dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            _aligner = Qwen3ForcedAligner.from_pretrained(
                str(MODEL_DIR),
                dtype=dtype,
                device_map=device,
            )
            _aligner_error = ""
        except Exception as exc:  # noqa: BLE001
            _aligner_error = f"{type(exc).__name__}: {exc}"
            raise
    return _aligner


def _cache_key(parts: list[str], text: str) -> str:
    payload = json.dumps({"parts": parts, "text": text}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_cache(key: str):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{key}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_cache(key: str, data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )


def _download(url: str, target: Path) -> None:
    with requests.get(url, stream=True, timeout=(15, 180), headers=HEADERS) as response:
        response.raise_for_status()
        with target.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)


def _extract_audio(parts: list[str], work: Path) -> Path:
    if not FFMPEG.exists():
        raise RuntimeError(f"找不到 ffmpeg：{FFMPEG}")
    local_parts: list[Path] = []
    for index, url in enumerate(parts):
        suffix = ".mp4" if ".mp4" in url.lower() else ".bin"
        target = work / f"part-{index}{suffix}"
        _download(url, target)
        local_parts.append(target)

    wav = work / "audio.wav"
    if len(local_parts) == 1:
        cmd = [
            str(FFMPEG), "-y", "-i", str(local_parts[0]),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ]
    else:
        concat_list = work / "concat.txt"
        concat_list.write_text(
            "\n".join("file '%s'" % p.as_posix().replace("'", "'\\''") for p in local_parts),
            encoding="utf-8",
        )
        cmd = [
            str(FFMPEG), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not wav.exists():
        raise RuntimeError("ffmpeg 抽音频失败：" + (proc.stderr or proc.stdout or "")[-1200:])
    return wav


def align(parts: list[str], text: str) -> dict[str, Any]:
    """Align known text against the audio in parts, returning word timestamps."""
    parts = [str(p).strip() for p in parts if str(p).strip()]
    text = str(text or "").strip()
    if not parts:
        raise ValueError("parts 不能为空")
    if not text:
        raise ValueError("text 不能为空")

    key = _cache_key(parts, text)
    cached = _load_cache(key)
    if cached:
        cached["cached"] = True
        return cached

    started = time.time()
    aligner = _get_aligner()
    with tempfile.TemporaryDirectory(prefix="lianbo-align-") as tmp:
        work = Path(tmp)
        wav = _extract_audio(parts, work)
        with _infer_lock:
            results = aligner.align(audio=str(wav), text=text, language="Chinese")
        items = []
        if results:
            for item in results[0]:
                items.append({
                    "text": str(getattr(item, "text", "")),
                    "start": float(getattr(item, "start_time", 0.0)),
                    "end": float(getattr(item, "end_time", 0.0)),
                })
    payload = {
        "items": items,
        "cached": False,
        "elapsed": round(time.time() - started, 2),
    }
    _save_cache(key, payload)
    return payload


def _extract_local_audio(files: list[Path], work: Path) -> Path:
    if not FFMPEG.exists():
        raise RuntimeError(f"找不到 ffmpeg：{FFMPEG}")
    wav = work / "audio.wav"
    if len(files) == 1:
        cmd = [
            str(FFMPEG), "-y", "-i", str(files[0]),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ]
    else:
        concat_list = work / "concat.txt"
        concat_list.write_text(
            "\n".join("file '%s'" % p.as_posix().replace("'", "'\\''") for p in files),
            encoding="utf-8",
        )
        cmd = [
            str(FFMPEG), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not wav.exists():
        raise RuntimeError("ffmpeg 抽音频失败：" + (proc.stderr or proc.stdout or "")[-1200:])
    return wav


def align_files(files: list[Path], text: str) -> dict[str, Any]:
    """Align uploaded local media files with known text."""
    text = str(text or "").strip()
    files = [Path(p) for p in files if Path(p).exists()]
    if not files:
        raise ValueError("没有收到媒体文件")
    if not text:
        raise ValueError("text 不能为空")
    started = time.time()
    aligner = _get_aligner()
    with tempfile.TemporaryDirectory(prefix="lianbo-align-") as tmp:
        work = Path(tmp)
        wav = _extract_local_audio(files, work)
        with _infer_lock:
            results = aligner.align(audio=str(wav), text=text, language="Chinese")
        items = []
        if results:
            for item in results[0]:
                items.append({
                    "text": str(getattr(item, "text", "")),
                    "start": float(getattr(item, "start_time", 0.0)),
                    "end": float(getattr(item, "end_time", 0.0)),
                })
    return {"items": items, "cached": False, "elapsed": round(time.time() - started, 2)}
