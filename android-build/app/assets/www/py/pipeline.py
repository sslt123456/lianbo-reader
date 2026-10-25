"""抓取 + 融合 + 缓存的主流水线。

CLI:
    python pipeline.py                     # 抓取最新一期
    python pipeline.py --date 2026-10-18   # 抓取指定日期
    python pipeline.py --date 2026-10-18 --force --tts
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from cctv import CCTVClient, EpisodeNotReady
from bili import BiliClient, select_videos_for_day
from summarize import build_digest, extract_terms

CST = timezone(timedelta(hours=8))
DATA_DIR = BASE_DIR / "data"
EPISODE_DIR = DATA_DIR / "episodes"
RAW_DIR = DATA_DIR / "raw"
UP_CACHE = DATA_DIR / "up_cache.json"
CONFIG_PATH = BASE_DIR / "config.json"


def now_cst() -> datetime:
    return datetime.now(CST)


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def episode_path(day: date | str) -> Path:
    day_str = day.isoformat() if isinstance(day, date) else str(day)
    return EPISODE_DIR / f"{day_str}.json"


def raw_path(day: date | str) -> Path:
    day_str = day.isoformat() if isinstance(day, date) else str(day)
    return RAW_DIR / f"{day_str}.json"


def load_episode(day: date | str) -> dict | None:
    path = episode_path(day)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def list_cached_dates() -> list[dict]:
    out: list[dict] = []
    if not EPISODE_DIR.exists():
        return out
    for path in sorted(EPISODE_DIR.glob("*.json"), reverse=True):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            out.append({
                "date": payload.get("date", path.stem),
                "display_date": payload.get("display_date", path.stem),
                "headline": payload.get("headline", ""),
                "generated_at": payload.get("generated_at", ""),
                "segment_count": (payload.get("stats") or {}).get("segment_count", len(payload.get("segments") or [])),
            })
        except Exception:  # noqa: BLE001
            continue
    return out


def _progress_wrapper(progress):
    def note(text: str) -> None:
        if progress:
            progress(text)
    return note


def _pick_ups(config: dict, target: date, progress, topics: list[str] | None = None) -> list[dict]:
    bili_cfg = config.get("bilibili") or {}
    ups_cfg = bili_cfg.get("ups") or []
    client = BiliClient(UP_CACHE, ttl_hours=int(bili_cfg.get("cache_ttl_hours") or 4))
    result: list[dict] = []
    for idx, up in enumerate(ups_cfg):
        name = up.get("name", "")
        uid = int(up.get("uid") or 0)
        progress(f"抓取 B 站 UP「{name}」最新视频…")
        try:
            fetched = client.fetch_up_videos(
                name,
                uid,
                limit=20,
                alternate_queries=up.get("alternate_queries") or [],
            )
            videos = fetched.get("videos") or []
            selected = select_videos_for_day(videos, target, name, topics=topics)
            # 搜索接口会截断简介，用详情接口补全所选视频的完整简介
            for video in selected:
                if not video.get("bvid"):
                    continue
                full = client.fetch_view(video["bvid"])
                if full.get("desc") and len(full["desc"]) > len(video.get("desc", "")):
                    video["desc"] = full["desc"]
                if full.get("title"):
                    video["title"] = full["title"]
                time.sleep(0.25)
            result.append({
                "name": name,
                "uid": uid,
                "role": up.get("role", ""),
                "accent": up.get("accent", "#5b8c85"),
                "videos": videos,
                "selected": selected,
                "from_cache": fetched.get("from_cache", False),
                "fetched_at": fetched.get("fetched_at", ""),
                "error": fetched.get("error", ""),
            })
        except Exception as exc:  # noqa: BLE001
            result.append({
                "name": name,
                "uid": uid,
                "role": up.get("role", ""),
                "accent": up.get("accent", "#5b8c85"),
                "videos": [],
                "selected": [],
                "from_cache": False,
                "fetched_at": "",
                "error": f"B站抓取失败：{exc}",
            })
        if idx < len(ups_cfg) - 1:
            time.sleep(1.0)
    return result


def _episode_topics(raw: dict) -> list[str]:
    """从当天标题与节目单中提取主题词，供 UP 关联素材挑选。"""
    counter: Counter[str] = Counter()
    for seg in raw.get("segments") or []:
        for term in extract_terms(seg.get("title", ""), 6):
            counter[term] += 2
    for term in extract_terms((raw.get("episode") or {}).get("brief", ""), 40):
        counter[term] += 1
    return [term for term, _ in counter.most_common(24)]


def build_episode(day: date | None = None, force: bool = False,
                  progress=None, use_latest: bool = False) -> dict:
    """抓取并生成一期简报；已有缓存时默认直接返回。"""
    config = load_config()
    client = CCTVClient()
    note = _progress_wrapper(progress)

    if day is None:
        note("查询最新一期新闻联播…")
        day = client.latest_day()
    if not force:
        cached = load_episode(day)
        if cached:
            cached["_from_cache"] = True
            return cached

    note(f"开始抓取 {day.isoformat()}《新闻联播》…")
    raw = client.fetch_episode(day, progress=progress)
    if not raw.get("segments"):
        raise EpisodeNotReady(f"{day.isoformat()} 暂无分条视频")

    # 保留原始抓取，便于二次摘要/排查
    try:
        _atomic_json(raw_path(day), raw)
    except Exception:  # noqa: BLE001
        pass

    up_data = _pick_ups(config, day, progress, topics=_episode_topics(raw))
    note("生成摘要与音视频联动稿…")
    digest = build_digest(raw, up_data)

    # 手动重抓时，如果播报稿发生变化，删除对应旧音频，避免听到过期语音
    try:
        old_episode = load_episode(day)
        if old_episode:
            old_narrations = {
                int(seg.get("id") or 0): seg.get("narration", "")
                for seg in old_episode.get("segments") or []
            }
            from tts import AUDIO_DIR
            audio_dir = AUDIO_DIR / day.isoformat()
            for seg in digest.get("segments") or []:
                seg_id = int(seg.get("id") or 0)
                if old_narrations.get(seg_id) and old_narrations.get(seg_id) != seg.get("narration"):
                    for path in audio_dir.glob(f"seg{seg_id:02d}_*.mp3"):
                        try:
                            path.unlink(missing_ok=True)
                        except OSError:
                            pass
    except Exception:  # noqa: BLE001
        pass

    # 精简视频字段
    for seg in digest.get("segments") or []:
        video = seg.get("video") or {}
        seg["video"] = {
            "parts": video.get("parts") or [],
            "mp4": video.get("mp4") or "",
            "quality": video.get("quality") or "",
            "hls": video.get("hls") or "",
            "duration_seconds": video.get("duration_seconds") or "",
        }

    digest["sources"] = {
        "cctv": {
            "name": "央视网《新闻联播》",
            "episode_url": digest["episode"].get("url", ""),
            "day_url": digest["episode"].get("day_url", ""),
            "fetched_at": now_cst().isoformat(timespec="seconds"),
        },
        "bilibili": [
            {
                "name": up.get("name"),
                "uid": up.get("uid"),
                "fetched_at": up.get("fetched_at"),
                "from_cache": up.get("from_cache", False),
                "error": up.get("error", ""),
                "video_count": len(up.get("videos") or []),
            }
            for up in up_data
        ],
    }
    digest["build"] = {
        "pipeline_version": 1,
        "built_at": now_cst().isoformat(timespec="seconds"),
        "from_cache": False,
    }
    _atomic_json(episode_path(day), digest)
    note(f"{day.isoformat()} 简报已更新")
    return digest


def latest_available_date() -> date:
    return CCTVClient().latest_day()


def ensure_latest(force: bool = False, progress=None) -> dict:
    latest = latest_available_date()
    return build_episode(latest, force=force, progress=progress)


def prewarm_audio(day: date | str, voice: str, progress=None) -> dict:
    from tts import generate_episode_audio
    episode = load_episode(day)
    if not episode:
        raise RuntimeError(f"没有 {day} 的简报，请先抓取")
    return generate_episode_audio(episode, voice, progress=progress)


def main() -> None:
    parser = argparse.ArgumentParser(description="新闻联播 × B站双UP 每日简报抓取")
    parser.add_argument("--date", help="指定日期，格式 YYYY-MM-DD；缺省抓取最新一期")
    parser.add_argument("--force", action="store_true", help="强制重新抓取")
    parser.add_argument("--tts", action="store_true", help="抓取后顺便生成全部语音")
    parser.add_argument("--voice", default="", help="语音音色（默认取 config.json）")
    args = parser.parse_args()

    config = load_config()
    day = date.fromisoformat(args.date) if args.date else None

    def progress(text: str) -> None:
        print(f"[pipeline] {text}")

    try:
        episode = build_episode(day, force=args.force or not args.date, progress=progress)
    except EpisodeNotReady as exc:
        print(f"[pipeline] {exc}")
        raise SystemExit(2)
    print(f"\n=== {episode['display_date']} · {episode['headline']} ===")
    print(episode["overview"])
    print(f"分条 {episode['stats']['segment_count']} 条 / 原片切片 {episode['stats']['source_video_count']} 条 / "
          f"语音稿约 {episode['stats']['estimated_voice_minutes']} 分钟")
    for up in episode.get("ups") or []:
        print(f"UP: {up['name']} · 关联 {up['matched_segments']} 条 · "
              f"{'缓存' if up['from_cache'] else '实时'} · {up['error'] or 'OK'}")
    if args.tts:
        voice = args.voice or config.get("default_voice") or "zh-CN-YunyangNeural"
        print(f"\n[pipeline] 生成语音：{voice}")
        result = prewarm_audio(episode["date"], voice, progress=lambda d, t, sid, err: print(
            f"[tts] {d}/{t}" + (f" 失败: {err}" if err else "")))
        ok = sum(1 for x in result.values() if x.get("ok"))
        print(f"[pipeline] 语音完成 {ok}/{len(result)}")


if __name__ == "__main__":
    main()
