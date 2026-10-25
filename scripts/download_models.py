"""下载源码运行所需的大文件。

源码仓库不包含 Vosk 模型（约 44 MB）和 Qwen 对齐模型（约 1.8 GB）。
运行本脚本只下载 Vosk；Qwen 请按 news-monitor/ALIGN_BACKEND.md 部署。
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOSK_URL = "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.tar.gz"
TARGETS = [
    ROOT / "news-monitor" / "static" / "vendor" / "vosk" / "model.tar.gz",
    ROOT / "android-build" / "app" / "assets" / "www" / "vendor" / "vosk" / "model.tar.gz",
]


def main() -> int:
    for target in TARGETS:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size > 10_000_000:
            print(f"已存在，跳过：{target}")
            continue
        print(f"下载 {VOSK_URL}")
        print(f"  -> {target}")
        with urllib.request.urlopen(VOSK_URL, timeout=60) as response, open(target, "wb") as out:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                total += len(chunk)
                print(f"\r{total / 1024 / 1024:.1f} MB", end="", flush=True)
        print("\n完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
