"""桌面快捷方式 / 开机自启的轻量启动器。

由 pythonw.exe 运行，不弹控制台、不经过 PowerShell：
1. 检查本地服务是否已启动；
2. 未启动时在后台拉起 app.py；
3. 等待健康检查通过后打开浏览器（--startup / --no-browser 时只启动服务）。
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOGDIR = BASE / "data" / "logs"
LOGDIR.mkdir(parents=True, exist_ok=True)
HEALTH_URL = "http://127.0.0.1:8766/health"
APP_URL = "http://127.0.0.1:8766/"
LOG_FILE = LOGDIR / "open_app.log"
BROWSERS = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
]
STARTUP = "--startup" in sys.argv
NO_BROWSER = STARTUP or "--no-browser" in sys.argv


def log(message: str) -> None:
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception:
        pass


def is_up() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def start_service() -> None:
    python = sys.executable
    pythonw = Path(python).with_name("pythonw.exe")
    executable = str(pythonw) if pythonw.exists() else python
    try:
        out = open(LOGDIR / "server.out.log", "ab")
        err = open(LOGDIR / "server.err.log", "ab")
        subprocess.Popen(
            [executable, str(BASE / "app.py")],
            cwd=str(BASE),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
        )
        log(f"已在后台启动服务：{executable} app.py")
    except Exception as exc:  # noqa: BLE001
        log(f"启动服务失败：{exc}")


def wait_until_ready(seconds: int = 35) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if is_up():
            return True
        time.sleep(0.7)
    return False


def open_client_window() -> bool:
    """优先用 Edge/Chrome 的 app 模式，得到一个独立桌面窗口。"""
    for browser in BROWSERS:
        if not browser.exists():
            continue
        try:
            subprocess.Popen(
                [str(browser), f"--app={APP_URL}", "--window-size=1440,1000"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                close_fds=True,
            )
            log(f"已用 app 模式打开：{browser}")
            return True
        except Exception as exc:  # noqa: BLE001
            log(f"app 模式打开失败 {browser}：{exc}")
    try:
        os.startfile(APP_URL)  # type: ignore[attr-defined]
        log("已用默认浏览器打开")
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"打开默认浏览器失败：{exc}")
        return False


def show_error(message: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(0, message, "联播夜读", 0x30)
    except Exception:
        pass


def main() -> int:
    if not is_up():
        log("服务未运行，准备启动")
        start_service()
        if not wait_until_ready():
            log("服务启动超时")
            if not STARTUP:
                show_error(
                    "联播夜读服务启动失败。\n\n"
                    "请查看：news-monitor\\data\\logs\\server.err.log\n"
                    "或手动运行 启动.bat。"
                )
            return 1
    log("服务已就绪")
    if not NO_BROWSER:
        if not open_client_window():
            show_error("服务已启动，但无法自动打开桌面窗口。\n请访问 http://127.0.0.1:8766/")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
