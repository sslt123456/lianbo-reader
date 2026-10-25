$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$candidates = @()
if ($env:DSH_BUNDLED_PYTHON -and (Test-Path $env:DSH_BUNDLED_PYTHON)) {
    $candidates += $env:DSH_BUNDLED_PYTHON
}
$bundled = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if (Test-Path $bundled) { $candidates += $bundled }
$localVenv = Join-Path $root ".venv\Scripts\python.exe"
if (Test-Path $localVenv) { $candidates += $localVenv }
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) { $candidates += $pythonCmd.Source }

$python = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $python) {
    Write-Host ""
    Write-Host "未找到 Python。请安装 Python 3.10+，或在 DSH 环境中运行。" -ForegroundColor Yellow
    Write-Host "安装依赖：pip install -r requirements.txt" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
}

# 检查依赖是否可用（优先使用项目内 vendor）
& $python -c "import sys; sys.path.insert(0, r'vendor'); import flask, requests, bs4, edge_tts, jieba" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "检测到依赖不完整，正在安装 requirements.txt…" -ForegroundColor Yellow
    & $python -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Host "依赖安装失败，请手动执行：$python -m pip install -r requirements.txt" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

Write-Host ""
Write-Host "  联播夜读 · 每日新闻联播联动简报" -ForegroundColor Red
Write-Host "  本地地址：http://127.0.0.1:8766" -ForegroundColor Gray
Write-Host "  按 Ctrl+C 停止服务" -ForegroundColor Gray
Write-Host ""

# 稍后自动打开浏览器（不阻塞服务）
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://127.0.0.1:8766/"
} | Out-Null

& $python app.py
