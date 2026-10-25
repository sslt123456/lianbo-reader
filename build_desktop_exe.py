"""打包 Windows 桌面客户端（PyInstaller one-folder）。

前置：
    python -m pip install -r news-monitor/requirements.txt pyinstaller

运行：
    python build_desktop_exe.py

输出：
    release/windows/LianboReader/LianboReader.exe
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    data = [
        (ROOT / "news-monitor" / "templates", "templates"),
        (ROOT / "news-monitor" / "static", "static"),
        (ROOT / "news-monitor" / "config.json", "."),
        (ROOT / "news-monitor" / "assets", "assets"),
    ]
    command = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onedir", "--windowed",
        "--name", "LianboReader",
        "--icon", str(ROOT / "news-monitor" / "assets" / "lianbo-classic.ico"),
        "--distpath", str(ROOT / "release" / "windows"),
        "--workpath", str(ROOT / "build-pyinstaller"),
        "--specpath", str(ROOT),
        "--paths", str(ROOT / "news-monitor"),
        "--paths", str(ROOT / "news-monitor" / "vendor"),
        "--hidden-import", "qwen_align",
        "--exclude-module", "torch",
        "--exclude-module", "torchaudio",
        "--exclude-module", "transformers",
        "--exclude-module", "qwen_asr",
        "--exclude-module", "modelscope",
    ]
    for source, dest in data:
        command += ["--add-data", f"{source};{dest}"]
    command.append(str(ROOT / "desktop_launcher.py"))
    print(" ".join(command))
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
