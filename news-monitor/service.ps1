$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$port = 8766
$logDir = Join-Path $root "data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "autostart.log"

function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# 已有实例在运行则不重复启动
try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($health.StatusCode -eq 200) {
        Write-Log "服务已在运行，跳过启动"
        exit 0
    }
} catch { }

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
    Write-Log "未找到 Python，无法启动服务"
    exit 1
}

$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }
$outLog = Join-Path $logDir "server.out.log"
$errLog = Join-Path $logDir "server.err.log"

Write-Log "开机自启：使用 $pythonw 启动服务"
try {
    $process = Start-Process -FilePath $pythonw -ArgumentList "app.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
} catch {
    Write-Log "启动进程失败：$($_.Exception.Message)"
    exit 1
}

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
        if ($health.StatusCode -eq 200) {
            Write-Log "服务启动成功（PID $($process.Id)）"
            exit 0
        }
    } catch { }
}

Write-Log "服务启动超时，请查看 data\logs\server.err.log"
exit 1
