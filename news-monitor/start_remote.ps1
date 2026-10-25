param(
    [switch]$NoPause,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$logDir = Join-Path $root "data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$remoteInfoPath = Join-Path $root "data\remote_url.json"
$tokenPath = Join-Path $root "data\remote_token.txt"

function Test-App {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8766/health" -TimeoutSec 3
        return ($response.StatusCode -eq 200)
    } catch { return $false }
}

# 1) 确保本地服务已启动
if (-not (Test-App)) {
    Write-Host "本地服务未运行，先启动服务…" -ForegroundColor Yellow
    $bundled = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe"
    if (Test-Path $bundled) {
        Start-Process -FilePath $bundled -ArgumentList @((Join-Path $root "open_app.py"), "--startup") -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    } else {
        $startupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "联播夜读自动监控.lnk"
        if (Test-Path $startupLnk) { Start-Process $startupLnk | Out-Null }
    }
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 700
        if (Test-App) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host "本地服务启动失败，请先双击 启动.bat。" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

# 2) 生成/读取访问密钥（首次生成后固定）
if (-not (Test-Path $tokenPath) -or -not (Get-Content -Raw $tokenPath).Trim()) {
    $token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).Substring(0, 40)
    [System.IO.File]::WriteAllText($tokenPath, $token, [System.Text.Encoding]::ASCII)
}
$token = (Get-Content -Raw $tokenPath).Trim()

# 3) 清理旧的反向隧道进程（localhost.run / serveo 旧版本）
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*localhost.run*" -or $_.CommandLine -like "*serveo.net*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 4) 建立 localhost.run HTTPS 反向隧道（无需注册 / 无需安装额外软件）
$outLog = Join-Path $logDir "remote_tunnel.out.log"
$errLog = Join-Path $logDir "remote_tunnel.err.log"
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
$sshArgs = @(
    "-tt",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=NUL",
    "-o", "ServerAliveInterval=60",
    "-o", "ExitOnForwardFailure=yes",
    "-R", "80:127.0.0.1:8766",
    "nokey@localhost.run"
)
Write-Host "正在建立公网 HTTPS 隧道…" -ForegroundColor Yellow
$sshProc = Start-Process -FilePath "$env:SystemRoot\System32\OpenSSH\ssh.exe" `
    -ArgumentList $sshArgs `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden

$baseUrl = ""
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    $text = ""
    if (Test-Path $outLog) { $text += (Get-Content -Raw $outLog) }
    if (Test-Path $errLog) { $text += (Get-Content -Raw $errLog) }
    if ($text -match "https://[a-z0-9]+\.lhr\.life") {
        $baseUrl = $Matches[0]
        break
    }
    if ($sshProc.HasExited) { break }
}

if (-not $baseUrl) {
    Write-Host "隧道建立失败，请检查网络。日志：$errLog" -ForegroundColor Red
    Get-Content $errLog -Tail 10 -ErrorAction SilentlyContinue
    if (-not $NoPause) { Read-Host "按回车退出" }
    exit 1
}

# 5) 写入状态、生成二维码页、打开本机远程访问页
$remoteUrl = "$baseUrl/r/$token/"
$info = [ordered]@{
    url        = $remoteUrl
    base_url   = $baseUrl
    token      = $token
    provider   = "localhost.run"
    started_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    pid        = $sshProc.Id
}
$json = $info | ConvertTo-Json
[System.IO.File]::WriteAllText($remoteInfoPath, $json, (New-Object System.Text.UTF8Encoding($false)))

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:8766/remote" | Out-Null
}

Write-Host ""
Write-Host "远程访问已开启 ✔" -ForegroundColor Green
Write-Host "  公网地址：$remoteUrl"
Write-Host "  已打开二维码页面；用手机扫描即可。"
Write-Host ""
Write-Host "提示：该地址为临时公网隧道，电脑重启/断网后重新运行本脚本。" -ForegroundColor Gray
Write-Host "关闭：双击 关闭远程访问.bat；本地服务不受影响。" -ForegroundColor Gray
Write-Host ""
if (-not $NoPause) {
    Read-Host "按回车关闭此窗口（隧道会继续在后台运行）"
}
