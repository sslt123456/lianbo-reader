"""B 站 UP 主最新视频抓取（公开搜索接口）。

实现要点：
  - 搜索接口需要 WBI 签名与有效 buvid cookie；
  - 先按 UP 昵称搜索、再按 mid 过滤，得到该 UP 最近视频；
  - 结果写入本地缓存，网络或风控失败时自动回退到缓存。

不依赖登录态；视频观点仅使用标题 / 简介 / 标签等公开文本。
"""

from __future__ import annotations

import hashlib
import html as html_mod
import json
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

import requests

CST = timezone(timedelta(hours=8))
SEARCH_API = "https://api.bilibili.com/x/web-interface/wbi/search/type"
NAV_API = "https://api.bilibili.com/x/web-interface/nav"
FINGER_API = "https://api.bilibili.com/x/frontend/finger/spi"
VIEW_API = "https://api.bilibili.com/x/web-interface/view"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

_MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
]


def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    return html_mod.unescape(text).replace("\u200b", "").strip()


def _format_pubdate(ts: int) -> str:
    try:
        dt = datetime.fromtimestamp(int(ts), CST)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:  # noqa: BLE001
        return ""


def _pub_date(ts: int) -> date | None:
    try:
        return datetime.fromtimestamp(int(ts), CST).date()
    except Exception:  # noqa: BLE001
        return None


class BiliClient:
    def __init__(self, cache_path: Path, ttl_hours: int = 4) -> None:
        self.cache_path = Path(cache_path)
        self.ttl = timedelta(hours=ttl_hours)
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._mixin_key = ""
        self._wbi_ready = False

    # ------------------------------------------------------------------ wbi
    def _set_cookie(self, name: str, value: str) -> None:
        self.session.cookies.set(name, value, domain=".bilibili.com", path="/")

    def _prepare(self) -> None:
        if self._wbi_ready:
            return
        try:
            r = self.session.get(FINGER_API, timeout=15)
            data = (r.json() or {}).get("data") or {}
            if data.get("b_3"):
                self._set_cookie("buvid3", data["b_3"])
            if data.get("b_4"):
                self._set_cookie("buvid4", data["b_4"])
        except Exception:  # noqa: BLE001
            pass
        r = self.session.get(NAV_API, timeout=15)
        nav = r.json() or {}
        wbi = ((nav.get("data") or {}).get("wbi_img") or {})
        img = wbi.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
        sub = wbi.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
        if not img or not sub:
            raise RuntimeError("无法获取 B 站 WBI 签名密钥")
        whole = img + sub
        self._mixin_key = "".join(whole[i] for i in _MIXIN_TAB if i < len(whole))[:32]
        self._wbi_ready = True

    def _wbi_query(self, params: dict[str, Any]) -> str:
        data = {k: str(v) for k, v in params.items()}
        data["wts"] = str(int(time.time()))
        data = {k: re.sub(r"[!'()*]", "", v) for k, v in data.items()}
        origin = urlencode(sorted(data.items()))
        data["w_rid"] = hashlib.md5((origin + self._mixin_key).encode()).hexdigest()
        return urlencode(sorted(data.items()))

    # ---------------------------------------------------------------- cache
    def _load_cache(self) -> dict:
        try:
            return json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _save_cache(self, cache: dict) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.cache_path)

    # --------------------------------------------------------------- search
    def search_videos(self, keyword: str, page: int = 1) -> list[dict]:
        self._prepare()
        params = {
            "search_type": "video",
            "keyword": keyword,
            "page": page,
            "order": "pubdate",
        }
        query = self._wbi_query(params)
        last_error = ""
        for attempt in range(3):
            try:
                r = self.session.get(f"{SEARCH_API}?{query}", timeout=20)
                if r.status_code == 412:
                    self._wbi_ready = False
                    self._prepare()
                    last_error = "B站风控 412"
                else:
                    payload = r.json() or {}
                    data = payload.get("data") or {}
                    results = data.get("result") or []
                    if results:
                        return results
                    last_error = payload.get("message") or "搜索无结果"
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                self._wbi_ready = False
            time.sleep(1.4 + attempt * 1.2)
        raise RuntimeError(last_error or "B站搜索失败")

    def normalize_result(self, item: dict) -> dict:
        bvid = item.get("bvid") or ""
        title = _clean_html(item.get("title", ""))
        desc = _clean_html(item.get("description") or item.get("desc") or "")
        tag = _clean_html(item.get("tag", ""))
        pub_ts = int(item.get("pubdate") or 0)
        pic = item.get("pic") or ""
        if pic.startswith("//"):
            pic = "https:" + pic
        upic = item.get("upic") or ""
        if upic.startswith("//"):
            upic = "https:" + upic
        return {
            "bvid": bvid,
            "aid": item.get("aid"),
            "title": title,
            "desc": desc,
            "tag": tag,
            "author": _clean_html(item.get("author", "")),
            "mid": int(item.get("mid") or 0),
            "url": f"https://www.bilibili.com/video/{bvid}" if bvid else "",
            "pubdate": pub_ts,
            "pubdate_text": _format_pubdate(pub_ts),
            "duration": item.get("duration") or "",
            "play": item.get("play") or 0,
            "like": item.get("like") or 0,
            "cover": pic,
            "avatar": upic,
        }

    def fetch_up_videos(self, name: str, uid: int, limit: int = 20,
                        alternate_queries: list[str] | None = None) -> dict:
        cache = self._load_cache()
        key = str(uid)
        cached = cache.get(key) or {}
        cached_at = 0
        try:
            cached_at = datetime.fromisoformat(cached.get("fetched_at", "")).timestamp()
        except Exception:  # noqa: BLE001
            cached_at = 0
        fresh = (time.time() - cached_at) < self.ttl.total_seconds() and cached.get("videos")
        if fresh:
            videos = cached["videos"][:limit]
            return {"videos": videos, "from_cache": True, "fetched_at": cached.get("fetched_at")}

        queries = [name] + list(alternate_queries or [])
        collected: dict[str, dict] = {}
        error = ""
        for query in queries:
            try:
                results = self.search_videos(query, page=1)
                for item in results:
                    if int(item.get("mid") or 0) != int(uid):
                        continue
                    norm = self.normalize_result(item)
                    if norm["bvid"] and norm["bvid"] not in collected:
                        collected[norm["bvid"]] = norm
                if len(collected) >= 8:
                    break
            except Exception as exc:  # noqa: BLE001
                error = str(exc)
            time.sleep(1.2)

        videos = sorted(collected.values(), key=lambda v: v.get("pubdate", 0), reverse=True)[:limit]
        if videos:
            cache[key] = {
                "name": name,
                "uid": uid,
                "fetched_at": datetime.now(CST).isoformat(timespec="seconds"),
                "videos": videos,
            }
            self._save_cache(cache)
            return {"videos": videos, "from_cache": False, "fetched_at": cache[key]["fetched_at"], "error": error}

        # 回退缓存（即使过期）
        if cached.get("videos"):
            return {
                "videos": cached["videos"][:limit],
                "from_cache": True,
                "fetched_at": cached.get("fetched_at"),
                "error": error or "使用本地缓存",
            }
        return {"videos": [], "from_cache": False, "fetched_at": "", "error": error or "没有抓到视频"}

    def fetch_view(self, bvid: str) -> dict:
        """视频详情兜底（搜索结果的简介通常已足够）。"""
        try:
            r = self.session.get(VIEW_API, params={"bvid": bvid}, timeout=18)
            payload = r.json() or {}
            data = payload.get("data") or {}
            return {
                "title": data.get("title", ""),
                "desc": data.get("desc", ""),
                "pubdate": data.get("pubdate", 0),
            }
        except Exception:  # noqa: BLE001
            return {}


def select_videos_for_day(videos: list[dict], target: date, up_name: str,
                          topics: list[str] | None = None) -> list[dict]:
    """为一期联播挑选 UP 关联视频。

    你好小谢同志：优先挑标题写着当日日期的“极速版+解读”；
    原点公社：保留最新一期“一周复盘解读”作为周度坐标，再按当日主题
    从最近视频中挑选 2 条最相关的补充素材。
    """
    if not videos:
        return []
    target_cn = f"{target.month}月{target.day}日"
    target_full = f"{target.year}年{target.month}月{target.day}日"
    exact: list[dict] = []
    near: list[dict] = []
    for video in videos:
        title = video.get("title", "")
        pub = _pub_date(video.get("pubdate", 0))
        if target_full in title or target_cn in title:
            exact.append(video)
        elif pub and abs((pub - target).days) <= 1 and "新闻联播" in title:
            near.append(video)
    weekly = [v for v in videos if "一周复盘" in v.get("title", "") or "周复盘" in v.get("title", "")]

    if "小谢" in up_name:
        if exact:
            return [exact[0]]
        if near:
            return [near[0]]
        return [videos[0]]

    # 原点公社：周复盘 + 主题相关补充
    topics = [t for t in (topics or []) if len(t) >= 2]
    chosen: list[dict] = []
    if weekly:
        chosen.append(weekly[0])

    def relevance(video: dict) -> tuple[int, int]:
        text = video.get("title", "") + " " + video.get("desc", "") + " " + video.get("tag", "")
        hits = sum(1 for t in set(topics) if t and t in text)
        return hits, int(video.get("pubdate") or 0)

    ranked = sorted(
        [v for v in videos if v not in chosen],
        key=relevance,
        reverse=True,
    )
    for video in ranked:
        if len(chosen) >= 3:
            break
        if relevance(video)[0] <= 0 and len(chosen) >= 2:
            break
        chosen.append(video)
    if len(chosen) == 1:
        for video in videos:
            if video not in chosen:
                chosen.append(video)
                break
    return chosen[:3]
