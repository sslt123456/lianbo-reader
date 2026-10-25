"""「联播夜读」本地 Web 服务。

启动:
    python app.py
默认地址:
    http://127.0.0.1:8766
"""

from __future__ import annotations

import base64
import io
import ipaddress
import json
import secrets
import socket
import sys
import tempfile
import shutil
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

BASE_DIR = Path(__file__).resolve().parent
_VENDOR = BASE_DIR / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from flask import Flask, jsonify, make_response, redirect, render_template, request, send_file

import qrcode
import pipeline
import tts
from cctv import EpisodeNotReady
from summarize import display_date

CST = timezone(timedelta(hours=8))
CONFIG = pipeline.load_config()
DEFAULT_VOICE = CONFIG.get("default_voice") or "zh-CN-YunyangNeural"
VOICES = CONFIG.get("voices") or [{"id": DEFAULT_VOICE, "name": DEFAULT_VOICE, "desc": ""}]
VOICE_IDS = {v["id"] for v in VOICES}
MONITOR_TIME = CONFIG.get("monitor_time") or "19:35"
PORT = int(CONFIG.get("port") or 8766)
REMOTE_TOKEN_PATH = BASE_DIR / "data" / "remote_token.txt"
REMOTE_INFO_PATH = BASE_DIR / "data" / "remote_url.json"
REMOTE_COOKIE = "lianbo_remote"
try:
    MONITOR_H, MONITOR_M = [int(x) for x in MONITOR_TIME.split(":")]
except Exception:  # noqa: BLE001
    MONITOR_H, MONITOR_M = 19, 35

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024
app.config["JSON_AS_ASCII"] = False
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.json.ensure_ascii = False
app.jinja_env.auto_reload = True

STATE_LOCK = threading.Lock()
AUDIO_LOCKS: dict[str, threading.Lock] = {}
AUDIO_JOBS: dict[str, dict] = {}
REFRESH_JOBS: dict[str, dict] = {}
MONITOR_STATE_PATH = BASE_DIR / "data" / "monitor_state.json"

STATE: dict = {
    "started_at": datetime.now(CST).isoformat(timespec="seconds"),
    "monitor": {
        "enabled": True,
        "time": MONITOR_TIME,
        "last_check": "",
        "last_success": "",
        "last_date": "",
        "last_error": "",
        "message": "监控已启动，等待检查…",
        "next_retry": "",
    },
    "refresh_jobs": REFRESH_JOBS,
    "audio_jobs": AUDIO_JOBS,
    "latest_known": "",
}


def now_cst() -> datetime:
    return datetime.now(CST)


def detect_lan_ips() -> list[str]:
    """返回本机可用于手机/平板访问的局域网 IPv4 地址。"""
    candidates: set[str] = set()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.8)
        sock.connect(("8.8.8.8", 80))
        candidates.add(sock.getsockname()[0])
        sock.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.add(info[4][0])
    except Exception:  # noqa: BLE001
        pass

    valid: list[str] = []
    for value in candidates:
        try:
            addr = ipaddress.ip_address(value)
        except ValueError:
            continue
        if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            continue
        if addr.is_private and value not in valid:
            valid.append(value)
    # 家庭/办公 Wi‑Fi 常见的 192.168 / 10 / 172.16-31 优先
    valid.sort(key=lambda value: (0 if value.startswith("192.168.") else 1, value))
    return valid


def mobile_urls() -> tuple[list[str], str]:
    urls = [f"http://{ip}:{PORT}/" for ip in detect_lan_ips()]
    primary = urls[0] if urls else f"http://127.0.0.1:{PORT}/"
    return urls, primary


def qr_data_uri(text: str) -> str:
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    image = qr.make_image(fill_color="#17202a", back_color="#fffdf8")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def load_remote_token() -> str:
    try:
        return REMOTE_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except Exception:  # noqa: BLE001
        return ""


def load_remote_info() -> dict:
    try:
        return json.loads(REMOTE_INFO_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def is_local_request() -> bool:
    """局域网/本机访问放行；公网隧道访问需要 token。"""
    forwarded = request.headers.get("X-Forwarded-For") or request.headers.get("X-Real-IP")
    forwarded_host = request.headers.get("X-Forwarded-Host")
    host = (forwarded_host or request.host or "").split(",")[0].strip()
    if forwarded:
        return False
    if host.startswith("["):
        host = host.split("]")[0].lstrip("[")
    elif ":" in host:
        host = host.rsplit(":", 1)[0]
    host = host.strip().lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_loopback or addr.is_private or addr.is_link_local
    except ValueError:
        return False


@app.before_request
def guard_remote_access():
    if request.path in {"/health"}:
        return None
    if is_local_request():
        return None
    token = load_remote_token()
    if not token:
        return _remote_denied("远程访问未启用。", 403)

    path_token = ""
    redirect_path = ""
    if request.path.startswith("/r/"):
        parts = request.path.split("/", 3)
        if len(parts) >= 3:
            path_token = parts[2]
            tail = parts[3] if len(parts) > 3 else ""
            redirect_path = "/" + tail.lstrip("/")

    query_token = (request.args.get("k") or "").strip()
    cookie_token = (request.cookies.get(REMOTE_COOKIE) or "").strip()

    def same(value: str) -> bool:
        try:
            return bool(value) and secrets.compare_digest(value, token)
        except TypeError:
            return value == token

    if path_token:
        if not same(path_token):
            return _remote_denied("远程访问密钥无效或已过期，请重新扫描二维码。", 401)
        request.environ["LIANBO_REMOTE_COOKIE"] = token
        if request.method == "GET":
            response = redirect(redirect_path or "/")
            response.set_cookie(
                REMOTE_COOKIE, token, max_age=60 * 60 * 24 * 60,
                httponly=True, samesite="Lax", secure=request.is_secure,
            )
            return response
        return None

    if not (same(query_token) or same(cookie_token)):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "远程访问密钥无效"}), 401
        return _remote_denied("远程访问密钥无效或已过期，请重新扫描二维码。", 401)

    # 首次带 ?k= 访问：写入 cookie，并跳转去掉 URL 中的密钥
    request.environ["LIANBO_REMOTE_COOKIE"] = token
    if query_token and request.method == "GET" and not request.path.startswith("/api/"):
        args = request.args.to_dict(flat=False)
        args.pop("k", None)
        clean = request.path + (("?" + urlencode(args, doseq=True)) if args else "")
        response = redirect(clean)
        response.set_cookie(
            REMOTE_COOKIE, token, max_age=60 * 60 * 24 * 60,
            httponly=True, samesite="Lax", secure=request.is_secure,
        )
        return response
    return None


def _remote_denied(message: str, status: int):
    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>联播夜读 · 访问受限</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ec;color:#1e242b;font-family:-apple-system,'Microsoft YaHei',sans-serif">
<div style="max-width:440px;padding:28px;text-align:center;line-height:1.8">
<div style="width:46px;height:46px;margin:0 auto 14px;border-radius:50%;background:#f4e3e2;color:#b31722;display:grid;place-items:center;font-size:24px;font-family:serif">联</div>
<h2 style="margin:0 0 8px;font-family:serif;font-weight:600">联播夜读 · 访问受限</h2>
<p style="margin:0;color:#7a766d;font-size:13px">{message}</p>
</div></body></html>"""
    return make_response(html, status)


def load_monitor_state() -> None:
    try:
        payload = json.loads(MONITOR_STATE_PATH.read_text(encoding="utf-8"))
        with STATE_LOCK:
            STATE["monitor"].update({k: v for k, v in payload.items() if k in STATE["monitor"]})
    except Exception:  # noqa: BLE001
        pass


def save_monitor_state() -> None:
    try:
        MONITOR_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with STATE_LOCK:
            payload = dict(STATE["monitor"])
        tmp = MONITOR_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(MONITOR_STATE_PATH)
    except Exception:  # noqa: BLE001
        pass


def validate_date(value: str) -> str:
    try:
        day = date.fromisoformat(value)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"日期格式应为 YYYY-MM-DD：{value}") from exc
    if day.year < 2020 or day > now_cst().date() + timedelta(days=1):
        raise ValueError(f"日期超出可抓取范围：{value}")
    return day.isoformat()


def episode_with_audio(episode: dict, voice: str | None = None) -> dict:
    voice = voice if voice in VOICE_IDS else DEFAULT_VOICE
    payload = dict(episode)
    ready = []
    total = 0
    for segment in payload.get("segments") or []:
        seg_id = int(segment.get("id") or 0)
        if not seg_id:
            continue
        total += 1
        info = tts.describe_audio(payload["date"], seg_id, voice)
        segment["audio"] = info
        if info.get("ready"):
            ready.append(seg_id)
    payload["audio_manifest"] = {
        "voice": voice,
        "ready": ready,
        "ready_count": len(ready),
        "total": total,
    }
    return payload


# ------------------------------------------------------------------ refresh
def start_refresh(day_str: str, reason: str = "manual") -> dict:
    day_str = validate_date(day_str)
    with STATE_LOCK:
        job = REFRESH_JOBS.get(day_str)
        if job and job.get("status") == "running":
            return dict(job)
        job = {
            "date": day_str,
            "status": "running",
            "started_at": now_cst().isoformat(timespec="seconds"),
            "finished_at": "",
            "step": "准备抓取…",
            "error": "",
            "reason": reason,
        }
        REFRESH_JOBS[day_str] = job

    def progress(text: str) -> None:
        with STATE_LOCK:
            if day_str in REFRESH_JOBS:
                REFRESH_JOBS[day_str]["step"] = text

    def work() -> None:
        try:
            episode = pipeline.build_episode(date.fromisoformat(day_str), force=True, progress=progress)
            with STATE_LOCK:
                REFRESH_JOBS[day_str].update({
                    "status": "done",
                    "finished_at": now_cst().isoformat(timespec="seconds"),
                    "step": "完成",
                    "headline": episode.get("headline", ""),
                })
                STATE["monitor"].update({
                    "last_success": now_cst().isoformat(timespec="seconds"),
                    "last_date": day_str,
                    "last_error": "",
                    "message": f"{day_str} 简报已更新",
                    "next_retry": "",
                })
                if day_str > (STATE.get("latest_known") or ""):
                    STATE["latest_known"] = day_str
            save_monitor_state()
        except EpisodeNotReady as exc:
            with STATE_LOCK:
                REFRESH_JOBS[day_str].update({
                    "status": "waiting",
                    "finished_at": now_cst().isoformat(timespec="seconds"),
                    "step": "等待节目发布",
                    "error": str(exc),
                })
                STATE["monitor"].update({
                    "last_check": now_cst().isoformat(timespec="seconds"),
                    "last_error": str(exc),
                    "message": f"{day_str} 节目尚未发布，稍后自动重试",
                    "next_retry": (now_cst() + timedelta(minutes=5)).isoformat(timespec="seconds"),
                })
            save_monitor_state()
        except Exception as exc:  # noqa: BLE001
            with STATE_LOCK:
                REFRESH_JOBS[day_str].update({
                    "status": "error",
                    "finished_at": now_cst().isoformat(timespec="seconds"),
                    "step": "失败",
                    "error": str(exc),
                })
                STATE["monitor"].update({
                    "last_check": now_cst().isoformat(timespec="seconds"),
                    "last_error": str(exc),
                    "message": f"抓取失败：{exc}",
                    "next_retry": (now_cst() + timedelta(minutes=10)).isoformat(timespec="seconds"),
                })
            save_monitor_state()

    threading.Thread(target=work, name=f"refresh-{day_str}", daemon=True).start()
    return dict(job)


# -------------------------------------------------------------------- audio
def audio_lock(key: str) -> threading.Lock:
    with STATE_LOCK:
        if key not in AUDIO_LOCKS:
            AUDIO_LOCKS[key] = threading.Lock()
        return AUDIO_LOCKS[key]


def ensure_audio(episode: dict, segment_id: int, voice: str) -> Path:
    seg = next((s for s in episode.get("segments") or [] if int(s.get("id") or 0) == segment_id), None)
    if not seg:
        raise ValueError("分条不存在")
    path = tts.audio_path(episode["date"], segment_id, voice)
    if tts.is_ready(episode["date"], segment_id, voice):
        return path
    lock = audio_lock(f"{episode['date']}:{voice}:{segment_id}")
    with lock:
        if tts.is_ready(episode["date"], segment_id, voice):
            return path
        tts.generate_audio(seg.get("narration", ""), voice, path)
    return path


def start_audio_job(day_str: str, voice: str) -> dict:
    key = f"{day_str}:{voice}"
    with STATE_LOCK:
        job = AUDIO_JOBS.get(key)
        if job and job.get("running"):
            return dict(job)
        job = {
            "date": day_str,
            "voice": voice,
            "running": True,
            "done": 0,
            "total": 0,
            "errors": [],
            "started_at": now_cst().isoformat(timespec="seconds"),
            "finished_at": "",
        }
        AUDIO_JOBS[key] = job
    episode = pipeline.load_episode(day_str)
    if not episode:
        with STATE_LOCK:
            job.update({"running": False, "finished_at": now_cst().isoformat(timespec="seconds"),
                        "errors": ["当天简报不存在"]})
        return dict(job)

    def progress(done: int, total: int, seg_id, error: str) -> None:
        with STATE_LOCK:
            job["done"] = done
            job["total"] = total
            if error:
                job["errors"].append({"segment": seg_id, "error": error})

    def work() -> None:
        try:
            tts.generate_episode_audio(episode, voice, progress=progress, max_workers=3)
        finally:
            with STATE_LOCK:
                job["running"] = False
                job["finished_at"] = now_cst().isoformat(timespec="seconds")

    threading.Thread(target=work, name=f"tts-{key}", daemon=True).start()
    return dict(job)


# ----------------------------------------------------------------- monitor
def monitor_loop() -> None:
    load_monitor_state()
    time.sleep(2.5)
    last_latest_check = datetime.min.replace(tzinfo=CST)
    while True:
        now = now_cst()
        with STATE_LOCK:
            STATE["monitor"]["last_check"] = now.isoformat(timespec="seconds")
        try:
            due = (now.hour, now.minute) >= (MONITOR_H, MONITOR_M)
            cached = pipeline.list_cached_dates()
            latest_cached = cached[0]["date"] if cached else ""
            need_check = (now - last_latest_check) > timedelta(minutes=8)
            if need_check:
                try:
                    latest = pipeline.latest_available_date().isoformat()
                    last_latest_check = now
                    with STATE_LOCK:
                        STATE["latest_known"] = max(latest, STATE.get("latest_known") or "")
                        STATE["monitor"]["last_error"] = ""
                except Exception as exc:  # noqa: BLE001
                    with STATE_LOCK:
                        STATE["monitor"]["last_error"] = f"检查最新节目失败：{exc}"
                    latest = ""
                if latest and not pipeline.load_episode(latest):
                    # 开机补抓：只要最新一期尚未缓存，无论当前几点都立即抓取。
                    # 这样 19:35 后关机、第二天早晨才开机的用户也能自动补上漏看的一期。
                    with STATE_LOCK:
                        already = REFRESH_JOBS.get(latest, {}).get("status") == "running"
                        retry_at = STATE["monitor"].get("next_retry") or ""
                    if not already:
                        retry_ok = True
                        if retry_at:
                            try:
                                retry_ok = now >= datetime.fromisoformat(retry_at)
                            except Exception:  # noqa: BLE001
                                retry_ok = True
                        if retry_ok:
                            start_refresh(latest, reason="monitor")
                if now.hour == MONITOR_H and now.minute < MONITOR_M:
                    with STATE_LOCK:
                        STATE["monitor"]["message"] = f"今晚 {MONITOR_TIME} 自动抓取新闻联播"
                elif latest_cached:
                    with STATE_LOCK:
                        if not REFRESH_JOBS.get(latest_cached, {}).get("status") == "running":
                            STATE["monitor"]["message"] = f"已收录 {latest_cached}，等待下一期"
            else:
                with STATE_LOCK:
                    if latest_cached and not STATE["monitor"].get("last_error"):
                        STATE["monitor"]["message"] = f"已收录 {latest_cached}，监控运行中"
        except Exception as exc:  # noqa: BLE001
            with STATE_LOCK:
                STATE["monitor"]["last_error"] = str(exc)
                STATE["monitor"]["message"] = f"监控异常：{exc}"
        time.sleep(55)


# ------------------------------------------------------------------- routes
@app.after_request
def add_headers(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    if request.path.startswith("/api/forced-align"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Max-Age"] = "86400"
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    resp.headers["Referrer-Policy"] = "no-referrer"
    token = request.environ.get("LIANBO_REMOTE_COOKIE")
    if token and not resp.headers.get("Set-Cookie"):
        resp.set_cookie(
            REMOTE_COOKIE, token, max_age=60 * 60 * 24 * 60,
            httponly=True, samesite="Lax", secure=request.is_secure,
        )
    return resp


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/mobile")
def mobile_page():
    urls, primary = mobile_urls()
    return render_template(
        "mobile.html",
        primary=primary,
        urls=urls,
        qr=qr_data_uri(primary),
        port=PORT,
        today=now_cst().date().isoformat(),
    )


@app.route("/api/qr.png")
def api_qr():
    text = (request.args.get("text") or "").strip()
    if not text:
        _, text = mobile_urls()
    if len(text) > 512:
        return jsonify({"ok": False, "error": "二维码内容过长"}), 400
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    image = qr.make_image(fill_color="#17202a", back_color="#fffdf8")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return send_file(buffer, mimetype="image/png")


@app.route("/remote")
def remote_page():
    if not is_local_request():
        return _remote_denied("远程访问状态只能在运行服务的电脑上查看。", 403)
    info = load_remote_info()
    remote_url = (info.get("url") or "").strip()
    return render_template(
        "remote.html",
        remote_url=remote_url,
        base_url=(info.get("base_url") or "").strip(),
        started_at=(info.get("started_at") or "").strip(),
        qr=qr_data_uri(remote_url) if remote_url else "",
        log_path=str(BASE_DIR / "data" / "logs" / "serveo.out.log"),
    )


@app.route("/api/remote-info")
def api_remote_info():
    if not is_local_request():
        return jsonify({"ok": False, "error": "仅本机可查看"}), 403
    info = load_remote_info()
    return jsonify({"ok": True, "remote": {
        "url": info.get("url", ""),
        "base_url": info.get("base_url", ""),
        "started_at": info.get("started_at", ""),
        "pid": info.get("pid"),
    }})


@app.route("/sw.js")
def service_worker():
    response = send_file(BASE_DIR / "static" / "sw.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": now_cst().isoformat(timespec="seconds")})


@app.route("/api/config")
def api_config():
    return jsonify({
        "app_name": CONFIG.get("app_name", "联播夜读"),
        "monitor_time": MONITOR_TIME,
        "default_voice": DEFAULT_VOICE,
        "voices": VOICES,
        "ups": [
            {"name": up.get("name"), "uid": up.get("uid"), "role": up.get("role"), "accent": up.get("accent")}
            for up in (CONFIG.get("bilibili") or {}).get("ups", [])
        ],
        "today": now_cst().date().isoformat(),
    })


@app.route("/api/dates")
def api_dates():
    cached = pipeline.list_cached_dates()
    with STATE_LOCK:
        latest_known = STATE.get("latest_known") or ""
        monitor = dict(STATE["monitor"])
    return jsonify({"dates": cached, "latest_known": latest_known, "monitor": monitor,
                    "today": now_cst().date().isoformat()})


@app.route("/api/episode")
def api_episode():
    raw_date = request.args.get("date") or ""
    try:
        day_str = validate_date(raw_date) if raw_date else (pipeline.list_cached_dates()[0]["date"] if pipeline.list_cached_dates() else "")
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    if not day_str:
        return jsonify({"ok": False, "error": "还没有任何缓存，请先抓取最新一期"}), 404
    episode = pipeline.load_episode(day_str)
    if not episode:
        with STATE_LOCK:
            job = dict(REFRESH_JOBS.get(day_str) or {})
        return jsonify({
            "ok": False,
            "error": f"{day_str} 还没有简报，请点击“立即抓取”",
            "refresh": job,
        }), 404
    # 新版只返回文字与原片信息；音视频全部使用央视/B站原片，不生成 TTS。
    payload = dict(episode)
    payload["ok"] = True
    payload["cached_dates"] = [x["date"] for x in pipeline.list_cached_dates()]
    return jsonify(payload)


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    payload = request.get_json(silent=True) or {}
    day_str = payload.get("date")
    if not day_str:
        try:
            candidate = pipeline.list_cached_dates()
            today = now_cst().date().isoformat()
            cached_today = any(x["date"] == today for x in candidate)
            day_str = today if not cached_today else (candidate[0]["date"] if candidate else today)
            if day_str < today:
                # 手动刷新时默认抓今天；如果今天没有，再退回最新可抓日期
                try:
                    latest = pipeline.latest_available_date().isoformat()
                    day_str = max(day_str, latest)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            day_str = now_cst().date().isoformat()
    try:
        job = start_refresh(day_str, reason="manual")
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "refresh": job})


@app.route("/api/status")
def api_status():
    with STATE_LOCK:
        monitor = dict(STATE["monitor"])
        refresh = {k: dict(v) for k, v in REFRESH_JOBS.items()}
        audio = {k: dict(v) for k, v in AUDIO_JOBS.items() if v.get("running")}
        latest_known = STATE.get("latest_known") or ""
    now = now_cst()
    next_run = now.replace(hour=MONITOR_H, minute=MONITOR_M, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    monitor["next_run"] = next_run.isoformat(timespec="seconds")
    monitor["today"] = now.date().isoformat()
    return jsonify({
        "ok": True,
        "server_time": now.isoformat(timespec="seconds"),
        "monitor": monitor,
        "refresh_jobs": refresh,
        "audio_jobs": audio,
        "latest_known": latest_known,
        "cached_dates": pipeline.list_cached_dates(),
    })


@app.route("/api/audio/<day_str>/manifest")
def api_audio_manifest(day_str: str):
    try:
        day_str = validate_date(day_str)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    voice = request.args.get("voice") or DEFAULT_VOICE
    if voice not in VOICE_IDS:
        return jsonify({"ok": False, "error": "不支持的音色"}), 400
    episode = pipeline.load_episode(day_str)
    if not episode:
        return jsonify({"ok": False, "error": "当天简报不存在"}), 404
    items = {}
    for segment in episode.get("segments") or []:
        info = tts.describe_audio(day_str, int(segment.get("id") or 0), voice)
        items[str(segment.get("id"))] = info
    return jsonify({"ok": True, "date": day_str, "voice": voice, "items": items,
                    "ready": [int(k) for k, v in items.items() if v.get("ready")],
                    "total": len(items)})


@app.route("/api/audio/<day_str>/<int:segment_id>.mp3")
def api_audio_file(day_str: str, segment_id: int):
    try:
        day_str = validate_date(day_str)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    voice = request.args.get("voice") or DEFAULT_VOICE
    if voice not in VOICE_IDS:
        return jsonify({"ok": False, "error": "不支持的音色"}), 400
    episode = pipeline.load_episode(day_str)
    if not episode:
        return jsonify({"ok": False, "error": "当天简报不存在"}), 404
    try:
        path = ensure_audio(episode, segment_id, voice)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"语音合成失败：{exc}"}), 500
    return send_file(path, mimetype="audio/mpeg", conditional=True, download_name=path.name)


@app.route("/api/audio/<day_str>/generate", methods=["POST"])
def api_audio_generate(day_str: str):
    try:
        day_str = validate_date(day_str)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    payload = request.get_json(silent=True) or {}
    voice = payload.get("voice") or DEFAULT_VOICE
    if voice not in VOICE_IDS:
        return jsonify({"ok": False, "error": "不支持的音色"}), 400
    if not pipeline.load_episode(day_str):
        return jsonify({"ok": False, "error": "当天简报不存在"}), 404
    job = start_audio_job(day_str, voice)
    return jsonify({"ok": True, "job": job})


@app.route("/api/audio/<day_str>/status")
def api_audio_status(day_str: str):
    try:
        day_str = validate_date(day_str)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    voice = request.args.get("voice") or DEFAULT_VOICE
    key = f"{day_str}:{voice}"
    with STATE_LOCK:
        job = dict(AUDIO_JOBS.get(key) or {})
    return jsonify({"ok": True, "job": job})


@app.route("/api/forced-align/status", methods=["GET"])
def api_forced_align_status():
    import qwen_align
    return jsonify(qwen_align.status())


@app.route("/api/forced-align/upload", methods=["POST", "OPTIONS"])
def api_forced_align_upload():
    if request.method == "OPTIONS":
        return ("", 204)
    import qwen_align
    text = request.form.get("text") or ""
    uploaded = request.files.getlist("files")
    if not uploaded:
        return jsonify({"ok": False, "error": "没有收到媒体文件"}), 400
    if not text.strip():
        return jsonify({"ok": False, "error": "text 不能为空"}), 400
    work = tempfile.mkdtemp(prefix="lianbo-upload-")
    paths = []
    try:
        for index, item in enumerate(uploaded):
            suffix = Path(item.filename or "part.mp4").suffix or ".mp4"
            path = Path(work) / f"part-{index}{suffix}"
            item.save(str(path))
            paths.append(path)
        result = qwen_align.align_files(paths, text)
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.route("/api/forced-align", methods=["POST", "OPTIONS"])
def api_forced_align():
    if request.method == "OPTIONS":
        return ("", 204)
    import qwen_align
    payload = request.get_json(silent=True) or {}
    parts = payload.get("parts") or []
    text = payload.get("text") or ""
    if not isinstance(parts, list) or not parts:
        return jsonify({"ok": False, "error": "parts 不能为空"}), 400
    if not str(text).strip():
        return jsonify({"ok": False, "error": "text 不能为空"}), 400
    try:
        result = qwen_align.align([str(p) for p in parts], str(text))
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


@app.errorhandler(404)
def not_found(_):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "接口不存在"}), 404
    return render_template("index.html"), 200


def main() -> None:
    load_monitor_state()
    # 启动监控线程
    threading.Thread(target=monitor_loop, name="monitor", daemon=True).start()
    # 启动时若还没有任何缓存，后台抓一次最新
    try:
        if not pipeline.list_cached_dates():
            threading.Thread(target=lambda: _bootstrap_latest(), name="bootstrap", daemon=True).start()
    except Exception:  # noqa: BLE001
        pass
    port = PORT
    host = CONFIG.get("host") or "0.0.0.0"
    print(f"[联播夜读] 本机 http://127.0.0.1:{port}  (monitor {MONITOR_TIME}, bind {host})", flush=True)
    app.run(host=host, port=port, threaded=True, use_reloader=False)


def _bootstrap_latest() -> None:
    try:
        latest = pipeline.latest_available_date().isoformat()
        with STATE_LOCK:
            STATE["latest_known"] = latest
        if not pipeline.load_episode(latest):
            start_refresh(latest, reason="startup")
    except Exception as exc:  # noqa: BLE001
        with STATE_LOCK:
            STATE["monitor"]["last_error"] = str(exc)


if __name__ == "__main__":
    main()
