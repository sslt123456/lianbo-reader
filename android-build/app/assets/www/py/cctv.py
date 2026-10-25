"""央视网《新闻联播》抓取。

数据来源均为公开页面：
  - 每日节目单: https://tv.cctv.com/lm/xwlb/day/YYYYMMDD.shtml
  - 单条报道页: https://tv.cctv.com/YYYY/MM/DD/VIDE....shtml
  - 播放信息 API: https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=GUID

网络请求失败时抛出可读异常，由上层决定是否重试/降级。
"""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin

_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

import requests
from bs4 import BeautifulSoup


BASE = "https://tv.cctv.com"
DAY_URL = BASE + "/lm/xwlb/day/{stamp}.shtml"
HOME_URL = BASE + "/lm/xwlb/"
VIDEO_INFO_URL = "https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do"
VIDEO_META_URL = "https://api.cntv.cn/video/videoinfoByGuid"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Referer": "https://tv.cctv.com/",
    "Accept-Language": "zh-CN,zh;q=0.9",
}



class _ImmediateFuture:
    def __init__(self, value=None, exc=None):
        self._value = value
        self._exc = exc
    def result(self):
        if self._exc is not None:
            raise self._exc
        return self._value


class _ImmediatePool:
    """Pyodide 不支持线程时使用的顺序执行池。"""
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def submit(self, fn, *args, **kwargs):
        try:
            return _ImmediateFuture(fn(*args, **kwargs))
        except Exception as exc:
            return _ImmediateFuture(exc=exc)

class EpisodeNotReady(RuntimeError):
    """节目单存在但还没有当日视频（通常发生在新闻联播播出前）。"""


class CCTVError(RuntimeError):
    pass


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def http_get(url: str, *, timeout: int = 22, retries: int = 2, session: requests.Session | None = None):
    last = None
    for attempt in range(retries + 1):
        try:
            sess = session or requests
            resp = sess.get(url, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as exc:  # noqa: BLE001 - 汇总为 CCTVError
            last = exc
            if attempt < retries:
                time.sleep(0.8 + attempt * 0.7)
    raise CCTVError(f"请求失败：{url} -> {last}")


def _decode(resp: requests.Response) -> str:
    # 央视网部分页面不声明 charset，统一按 UTF-8 解码。
    return resp.content.decode("utf-8", "replace")


def _clean_ws(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def clean_title(raw: str) -> str:
    text = _clean_ws(raw)
    text = re.sub(r"^\[(视频|完整版)\]", "", text).strip()
    text = re.sub(r"^完整版", "", text).strip()
    return text


def short_topic(title: str, limit: int = 30) -> str:
    """给概览用的短主题，去掉系列栏目前缀。"""
    text = clean_title(title)
    text = re.sub(r"^【[^】]{2,24}】", "", text).strip()
    text = re.sub(r"^\[[^\]]{2,24}\]", "", text).strip()
    if len(text) > limit:
        # 尽量在标点处截断
        cut = max(text.rfind("，", 0, limit), text.rfind(" ", 0, limit), text.rfind("·", 0, limit))
        if cut < limit * 0.55:
            cut = limit
        text = text[:cut].rstrip("，、 ") + "…"
    return text


def format_clock(ms: int | None) -> str:
    if ms is None:
        return ""
    total = max(0, int(ms) // 1000)
    return f"{total // 60:02d}:{total % 60:02d}"


@dataclass
class DailyItem:
    url: str
    raw_title: str
    duration: str = ""
    image: str = ""


@dataclass
class DayPage:
    day: date
    url: str
    episode: DailyItem
    items: list[DailyItem] = field(default_factory=list)
    html: str = ""


class CCTVClient:
    def __init__(self) -> None:
        self.session = _session()

    # ------------------------------------------------------------------ pages
    def fetch_day(self, day: date) -> DayPage:
        url = DAY_URL.format(stamp=day.strftime("%Y%m%d"))
        resp = http_get(url, session=self.session)
        html = _decode(resp)
        soup = BeautifulSoup(html, "html.parser")
        entries: list[DailyItem] = []
        seen: set[str] = set()
        for li in soup.find_all("li"):
            a = li.find("a", href=re.compile(r"/VIDE\w+\.shtml"))
            if not a:
                continue
            href = urljoin(BASE, a.get("href", ""))
            if href in seen:
                continue
            seen.add(href)
            title = a.get("title") or a.get("alt") or a.get_text(" ", strip=True)
            dur_node = li.find("span")
            duration = _clean_ws(dur_node.get_text()) if dur_node else ""
            img = li.find("img")
            image = ""
            if img and img.get("src"):
                image = "https:" + img["src"] if img["src"].startswith("//") else img["src"]
            entries.append(DailyItem(url=href, raw_title=_clean_ws(title), duration=duration, image=image))

        if not entries:
            raise EpisodeNotReady(f"{day.isoformat()} 的节目单暂未发布")
        episode = entries[0]
        if "新闻联播" not in episode.raw_title:
            # 有些日期第一条不是完整版，按时长/标题兜底找完整版
            for item in entries:
                if "新闻联播" in item.raw_title and "19:00" in item.raw_title:
                    episode = item
                    break
        items = [it for it in entries if it.url != episode.url]
        if not items:
            raise EpisodeNotReady(f"{day.isoformat()} 暂无分条视频")
        return DayPage(day=day, url=url, episode=episode, items=items, html=html)

    def latest_day(self) -> date:
        resp = http_get(HOME_URL, session=self.session)
        html = _decode(resp)
        m = re.search(r"https://tv\.cctv\.com/(\d{4})/(\d{2})/(\d{2})/VIDE\w+\.shtml", html)
        if not m:
            raise CCTVError("无法从首页识别最新一期日期")
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    def fetch_segment_page(self, item: DailyItem) -> dict:
        resp = http_get(item.url, session=self.session)
        html = _decode(resp)
        soup = BeautifulSoup(html, "html.parser")
        title = clean_title(soup.title.get_text()) if soup.title else clean_title(item.raw_title)
        guid_m = re.search(r'var\s+guid\s*=\s*"([0-9a-f]{32})"', html)
        guid = guid_m.group(1) if guid_m else ""
        paragraphs: list[str] = []
        content = soup.select_one("#content_area")
        if content:
            for p in content.find_all(["p", "li"]):
                text = _clean_ws(p.get_text(" ", strip=True))
                if text and len(text) > 1:
                    paragraphs.append(text)
            if not paragraphs:
                text = _clean_ws(content.get_text("\n", strip=True))
                paragraphs = [t for t in text.splitlines() if t.strip()]
        elif soup.select_one(".content_area"):
            content = soup.select_one(".content_area")
            paragraphs = [
                _clean_ws(p.get_text(" ", strip=True))
                for p in content.find_all(["p", "li"])
                if _clean_ws(p.get_text(" ", strip=True))
            ]
        # 去重相邻重复段落
        dedup: list[str] = []
        for p in paragraphs:
            if not dedup or p != dedup[-1]:
                dedup.append(p)
        published = ""
        text_all = _clean_ws(soup.get_text(" ", strip=True))
        pm = re.search(r"(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2})", text_all)
        if pm:
            published = pm.group(1)
        image = ""
        og = soup.find("meta", property="og:image")
        if og and og.get("content"):
            image = og["content"]
            if image.startswith("//"):
                image = "https:" + image
        return {
            "page_title": title,
            "guid": guid,
            "paragraphs": dedup,
            "transcript": "\n".join(dedup),
            "published": published,
            "image": image or item.image,
        }

    # ------------------------------------------------------------- video info
    def fetch_video_info_for(self, guid: str) -> dict:
        if not guid:
            return {}
        try:
            resp = self.session.get(VIDEO_INFO_URL, params={"pid": guid}, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def fetch_meta_for(self, guid: str) -> dict:
        """节目元信息，包含整期节目的“本期主要内容”文字。"""
        if not guid:
            return {}
        try:
            resp = self.session.get(
                VIDEO_META_URL,
                params={"guid": guid, "serviceId": "tvcctv"},
                timeout=20,
            )
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def video_sources(self, info: dict) -> dict:
        """从播放信息中挑出可选清晰度与分段 mp4。

        央视网对超过 5 分钟的片段会拆成多个 mp4 文件，前端需要按顺序接力播放。
        """
        video = info.get("video") or {}
        qualities: list[dict] = []
        for key, label in (("chapters", "标清"), ("chapters2", "高清"), ("chapters3", "超清"), ("chapters4", "蓝光")):
            chapters = video.get(key) or []
            urls = [c.get("url") for c in chapters if c.get("url")]
            if urls:
                qualities.append({"label": label, "parts": urls})
        preferred = next((q for q in qualities if q["label"] == "高清"), None)
        if preferred is None and qualities:
            preferred = qualities[0]
        hls = info.get("hls_url") or ""
        manifest = info.get("manifest") or {}
        hls_h5 = ""
        for key in ("hls_h5e_url", "hls_enc_url", "hls_audio_url"):
            if manifest.get(key):
                hls_h5 = manifest[key]
                break
        return {
            "parts": preferred["parts"] if preferred else [],
            "mp4": preferred["parts"][0] if preferred else "",
            "quality": preferred["label"] if preferred else "",
            "qualities": qualities,
            "hls": hls or hls_h5,
            "duration_seconds": video.get("totalLength"),
        }

    # --------------------------------------------------------------- episode
    def fetch_episode(self, day: date, progress=None) -> dict:
        def note(text: str) -> None:
            if progress:
                progress(text)

        note("读取央视网当日节目单…")
        day_page = self.fetch_day(day)

        note("读取完整版播放信息…")
        full_meta = self.fetch_segment_page(day_page.episode)
        full_guid = full_meta.get("guid", "")
        full_info = self.fetch_video_info_for(full_guid)
        full_meta_info = self.fetch_meta_for(full_guid)
        full_segments = full_info.get("segments") or []
        by_guid = {s.get("guid"): s for s in full_segments if s.get("guid")}
        by_title = {}
        for s in full_segments:
            st = clean_title(s.get("title", ""))
            if st:
                by_title[st] = s

        note(f"抓取 {len(day_page.items)} 条报道的文字稿与原片信息…")
        segment_rows: list[dict | None] = [None] * len(day_page.items)

        def load_one(index: int, item: DailyItem) -> tuple[int, dict]:
            row: dict = {
                "index": index + 1,
                "url": item.url,
                "raw_title": clean_title(item.raw_title),
                "duration": item.duration,
                "image": item.image,
                "error": "",
            }
            try:
                page = self.fetch_segment_page(item)
                row["title"] = clean_title(page["page_title"] or item.raw_title)
                row["paragraphs"] = page["paragraphs"]
                row["transcript"] = page["transcript"]
                row["guid"] = page["guid"]
                row["published"] = page["published"]
                row["image"] = page["image"] or item.image
            except Exception as exc:  # noqa: BLE001
                row["title"] = clean_title(item.raw_title)
                row["paragraphs"] = []
                row["transcript"] = ""
                row["guid"] = ""
                row["published"] = ""
                row["error"] = f"文字稿抓取失败: {exc}"

            info = self.fetch_video_info_for(row.get("guid", ""))
            row["video"] = self.video_sources(info)
            if not row["video"].get("mp4"):
                row["error"] = (row["error"] + "；" if row["error"] else "") + "原片地址暂不可用"

            seg_meta = by_guid.get(row.get("guid", ""))
            if not seg_meta:
                seg_meta = by_title.get(clean_title(row["title"]))
            if seg_meta:
                row["offset"] = {
                    "start_ms": int(seg_meta.get("start") or 0),
                    "end_ms": int(seg_meta.get("end") or 0),
                    "start": format_clock(seg_meta.get("start")),
                    "end": format_clock(seg_meta.get("end")),
                }
            else:
                row["offset"] = {}
            return index, row

        # 央视网对并发比较友好，但保持温和的并发度。
        with _ImmediatePool() as pool:
            futures = [pool.submit(load_one, i, item) for i, item in enumerate(day_page.items)]
            done = 0
            for fut in futures:
                try:
                    idx, row = fut.result()
                    segment_rows[idx] = row
                except Exception as exc:  # noqa: BLE001
                    idx = futures.index(fut)
                    item = day_page.items[idx]
                    segment_rows[idx] = {
                        "index": idx + 1,
                        "url": item.url,
                        "raw_title": clean_title(item.raw_title),
                        "title": clean_title(item.raw_title),
                        "duration": item.duration,
                        "image": item.image,
                        "paragraphs": [],
                        "transcript": "",
                        "guid": "",
                        "published": "",
                        "video": {},
                        "offset": {},
                        "error": f"抓取失败: {exc}",
                    }
                done += 1
                if done % 3 == 0:
                    note(f"已抓取 {done}/{len(day_page.items)} 条报道…")
        segments = [row for row in segment_rows if row]
        segments.sort(key=lambda r: r["index"])

        note("整理完整版时间码…")
        brief = (full_meta_info.get("brief") or full_info.get("brief") or "").strip()
        full_sources = self.video_sources(full_info)
        episode = {
            "title": clean_title(day_page.episode.raw_title),
            "page_title": full_meta.get("page_title") or clean_title(day_page.episode.raw_title),
            "url": day_page.episode.url,
            "day_url": day_page.url,
            "duration": day_page.episode.duration,
            "image": day_page.episode.image or full_meta.get("image") or "",
            "guid": full_guid,
            "published": full_meta_info.get("time") or full_meta.get("published", ""),
            "brief": brief,
            "total_seconds": full_sources.get("duration_seconds") or full_info.get("video", {}).get("totalLength"),
            "full_hls": full_sources.get("hls", ""),
        }
        return {"date": day.isoformat(), "episode": episode, "segments": segments}
