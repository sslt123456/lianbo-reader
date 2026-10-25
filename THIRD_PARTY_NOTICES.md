# Third-Party Notices

This project is an independent personal project. It is not affiliated with,
endorsed by, or sponsored by CCTV, 央视网, Bilibili, Alibaba Cloud, or the
Vosk/Qwen projects.

## Runtime content

The application fetches publicly accessible pages and media URLs from CCTV
(央视网) and Bilibili at runtime. It does not bundle or redistribute
《新闻联播》 video/audio files. Copyright in those pages, videos, audio,
trademarks and program names remains with their respective owners. Users are
responsible for complying with the source sites' terms and applicable law.

## Bundled or used third-party software

| Component | License / notice |
| --- | --- |
| Python | PSF License |
| Flask | BSD-3-Clause |
| requests | Apache-2.0 |
| beautifulsoup4 | MIT |
| lxml | BSD-3-Clause |
| Vosk / vosk-browser | Apache-2.0 |
| Vosk small Chinese model | Apache-2.0 (model distributed separately) |
| hls.js | Apache-2.0 |
| edge-tts | LGPL-3.0 (legacy code path; the app's playback does not use TTS) |
| jieba | MIT |
| qrcode | BSD-3-Clause |
| PyInstaller | GPL-2.0-or-later with bootloader exception |
| Qwen3-ForcedAligner-0.6B | Apache-2.0 (model distributed separately) |

If you redistribute a build that includes an LGPL component, keep the
component's license/notice and comply with the LGPL's relinking/source
requirements. The MIT license in `LICENSE` applies only to this project's
original code, not to third-party components or fetched content.
