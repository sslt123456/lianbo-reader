# Qwen3-ForcedAligner 本地对齐后端

这条服务把“原片音频 + 正确文字稿”做成 **Qwen 强制对齐时间表**，供电脑端和安卓端共用。
模型不放进 APK；APK 只保存服务器地址，调用 `/api/forced-align/upload`。

## 1. 环境

已在本机验证：

- Windows 10/11
- Python 3.11
- NVIDIA GPU（RTX 4060 Laptop，8GB，CUDA 可用）或 CPU
- 模型：`Qwen/Qwen3-ForcedAligner-0.6B`，约 1.84 GB
- ffmpeg：`news-monitor/vendor/ffmpeg.exe`

依赖：

```bash
python -m pip install torch --index-url https://download.pytorch.org/whl/cu124
python -m pip install qwen-asr transformers==4.57.6 accelerate==1.12.0
python -m pip install librosa soundfile sox nagisa soynlp qwen-omni-utils
```

CPU 也可以，把 torch 的 CUDA wheel 换成普通 CPU wheel 即可。

## 2. 下载模型

```python
from modelscope.hub.snapshot_download import snapshot_download
snapshot_download(
    "Qwen/Qwen3-ForcedAligner-0.6B",
    local_dir=r"C:\...\news-monitor\models\Qwen3-ForcedAligner-0.6B",
)
```

默认模型路径：

```text
news-monitor/models/Qwen3-ForcedAligner-0.6B
```

可用环境变量覆盖：

```text
QWEN_ALIGN_MODEL
QWEN_ALIGN_FFMPEG
```

## 3. 启动

```bash
cd news-monitor
python app.py
```

服务地址：

```text
http://127.0.0.1:8766
```

检查：

```text
GET http://127.0.0.1:8766/api/forced-align/status
```

返回：

```json
{"ready":true,"loading":false,"cuda":true,"model":"...","ffmpeg":"..."}
```

首次请求会懒加载模型；GPU 通常几秒，CPU 十几秒。

## 4. 接口

```text
POST /api/forced-align/upload
Content-Type: multipart/form-data

files: 原片 mp4 分段（可多个）
text:  完整文字稿
```

返回：

```json
{
  "ok": true,
  "items": [
    {"text": "央", "start": 0.88, "end": 0.96},
    {"text": "视", "start": 0.96, "end": 1.12}
  ]
}
```

电脑端同源自动调用；安卓端在“同步”弹窗里填写服务器地址。

## 5. 安卓连接

同一 Wi-Fi：

```text
http://电脑局域网IP:8766
```

模拟器：

```text
http://10.0.2.2:8766
```

Windows 防火墙需要放行 8766 端口。安卓端上传原片分段到电脑，电脑抽音频、跑 Qwen，再把词时间戳返回。

## 6. 安全

- 不要把服务直接暴露到公网；
- 当前后端绑定 `0.0.0.0`，只建议在家庭局域网使用；
- 远程访问已有独立 token 保护，但对局域网是放开的；
- 服务器不开时，APK 自动回退到设备内 Vosk。
