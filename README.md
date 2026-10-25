# 联播夜读 · LianboReader

把每天央视《新闻联播》整理成可读、可听、可点句校准的联动简报。

项目包括：

- **Android 独立版 App**：WebView + 原生播放器，支持手机/平板；
- **Windows 桌面客户端**：本地 Flask 服务 + Edge 应用窗口；
- **原片原声**：直接播放央视/B 站公开原片，不做 TTS 合成；
- **字幕同步**：绝对时间轴、Vosk 离线词级对齐、可选的 Qwen3-ForcedAligner 后端；
- **后台播放**：安卓退到后台/锁屏后音频继续，通知栏显示当前字幕。

> 这是一个个人学习/信息整理项目，不是央视或 B 站官方产品。

## 版本

当前版本：**2.2.4**

- Android `versionCode 132`
- Windows 桌面客户端
- 字幕/强制对齐仍有少量误差，欢迎提交 issue/PR

## 下载

发布包不直接提交进 Git 仓库，建议放到 GitHub Releases：

- `联播夜读-2.2.4.apk`
- `LianboReader-2.2.4-Windows.zip`（解压后运行 `LianboReader.exe`）
- `LianboReader-2.2.4-source.zip`

## 主要功能

- 每日《新闻联播》条目、摘要、标签和重点；
- 文字稿 + 原片联动，点击条目打开原片；
- 原生视频播放，手机/平板/横屏/全屏；
- 绝对字幕时间轴，seek 后按 `currentTime` 查表，不累积漂移；
- Vosk 离线中文识别做词级锚定；
- 可选 Qwen3-ForcedAligner 强制对齐服务；
- 点句校准自学习（少量残余偏差可手动校准）；
- 安卓后台播放 + 通知栏字幕 + 暂停/继续/停止；
- 不使用 TTS 合成语音。

## 目录结构

```text
desktop_launcher.py          Windows EXE 入口
build_desktop_exe.py         PyInstaller 打包脚本
news-monitor/                桌面端 Flask 服务、模板、静态资源
android-build/               安卓源码、WebView 资源、APK 构建脚本
scripts/                     模型下载辅助脚本
docs/                        项目说明/图标
```

## 本地运行桌面端

需要 Python 3.11+。

```bash
python -m pip install -r news-monitor/requirements.txt
python desktop_launcher.py
```

浏览器打开 `http://127.0.0.1:8766/`；`desktop_launcher.py` 会优先用 Edge app 模式打开独立窗口。

### Vosk 模型

源码仓库不包含大模型文件。把 Vosk 小模型放到：

```text
news-monitor/static/vendor/vosk/model.tar.gz
android-build/app/assets/www/vendor/vosk/model.tar.gz
```

下载脚本：

```bash
python scripts/download_models.py
```

Vosk 小模型来源：<https://alphacephei.com/vosk/models>

### 可选 Qwen 强制对齐

桌面端的 Qwen3-ForcedAligner 服务是可选增强，模型约 1.8 GB，不放进仓库/APK/EXE：

```text
news-monitor/models/Qwen3-ForcedAligner-0.6B
```

部署说明见 [`news-monitor/ALIGN_BACKEND.md`](news-monitor/ALIGN_BACKEND.md)。

## 构建 Windows EXE

```bash
python -m pip install pyinstaller
python build_desktop_exe.py
```

输出在 `release/windows/LianboReader/`。注意：PyInstaller 是 one-folder 形式，`LianboReader.exe` 需要和 `_internal/` 一起分发。

## 构建 Android APK

源码在 `android-build/`，入口是 `android-build/build_apk.py`。该脚本依赖项目自带的 Android 工具链（aapt2/ecj/d8/apksig 等），工具链体积较大，不随源码仓库分发；发布包中直接提供构建好的 APK。

## 已知问题

- 采访、资料片、音乐段落的字幕仍可能有偏移；Qwen 强制对齐可改善，但不是 100%；
- 首次使用 Vosk 需要下载模型；
- 后台播放通知需要系统允许“联播夜读”的通知；
- 央视/B 站 CDN 在部分网络下不可用；
- 只处理公开页面，不绕过登录/付费/版权限制。

## 发布到 GitHub

推荐把源码目录作为仓库根目录：

```bash
git init
git add .
git commit -m "联播夜读 2.2.4"
git branch -M main
git remote add origin https://github.com/<your-name>/<repo>.git
git push -u origin main
```

APK、Windows ZIP 和源码 ZIP 放到 GitHub Releases，不建议提交进 Git 历史。

## License

本项目原创代码采用 MIT License，见 [`LICENSE`](LICENSE)。

第三方依赖、模型、视频/页面内容的许可和版权归各自权利人所有，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。项目不包含《新闻联播》视频文件；运行时从公开页面获取。
