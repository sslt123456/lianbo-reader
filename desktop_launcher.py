"""联播夜读 Windows 桌面启动器 / 打包入口。

开发环境直接运行：
    python desktop_launcher.py

PyInstaller 打包后：
    双击 exe -> 检查/启动内置本地服务 -> 用 Edge app 模式打开独立窗口。

同一个 exe 带 --server 参数时只跑 Flask 服务，供启动器作为后台子进程拉起。
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP_URL = "http://127.0.0.1:8766/"
HEALTH_URL = APP_URL + "health"


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def run_server() -> int:
    sys.path.insert(0, str(base_dir()))
    import app  # noqa: WPS433
    app.main()
    return 0


def is_up() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def start_server() -> None:
    base = base_dir()
    logs = base / "data" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    out = open(logs / "desktop-server.out.log", "ab")
    err = open(logs / "desktop-server.err.log", "ab")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(
        [sys.executable, "--server"],
        cwd=str(base),
        stdin=subprocess.DEVNULL,
        stdout=out,
        stderr=err,
        creationflags=creationflags,
        close_fds=True,
    )


def wait_ready(seconds: int = 60) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if is_up():
            return True
        time.sleep(0.7)
    return False


def _log(message: str) -> None:
    try:
        logs = base_dir() / "data" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        with open(logs / "desktop-launcher.log", "a", encoding="utf-8") as handle:
            handle.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + message + "\n")
    except Exception:
        pass


def open_window() -> bool:
    _log("open_window begin")
    candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    for browser in candidates:
        if not browser.exists():
            continue
        try:
            _log("launch " + str(browser))
            subprocess.Popen(
                [str(browser), f"--app={APP_URL}", "--window-size=1440,1000"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                close_fds=True,
            )
            _log("launch returned")
            return True
        except Exception as exc:
            _log("launch failed: " + repr(exc))
            continue
    try:
        os.startfile(APP_URL)  # type: ignore[attr-defined]
        _log("startfile ok")
        return True
    except Exception as exc:
        _log("startfile failed: " + repr(exc))
        return False


def show_error(message: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(0, message, "联播夜读", 0x30)
    except Exception:
        pass


def main() -> int:
    if "--server" in sys.argv:
        return run_server()
    _log("main begin frozen=" + str(getattr(sys, "frozen", False)))
    if not is_up():
        _log("server not up, starting")
        start_server()
        if not wait_ready():
            _log("server wait timeout")
            show_error(
                "联播夜读服务启动超时。\n\n"
                "请查看 data\\logs\\desktop-server.err.log，或从命令行运行 exe --server 查看错误。"
            )
            return 1
    _log("server ready")
    if not open_window():
        _log("open window failed")
        show_error("服务已启动，但无法打开桌面窗口。\n请访问 http://127.0.0.1:8766/")
        return 1
    _log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
