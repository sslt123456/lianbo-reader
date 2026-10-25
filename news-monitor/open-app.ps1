param([switch]$NoBrowser)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$port = 8766
$base = "http://127.0.0.1:$port"
$healthUrl = "$base/health"
$appUrl = "$base/"

function Test-App {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (-not (Test-App)) {
    $service = Join-Path $root "service.ps1"
    # 不等待子进程：service.ps1 启动 pythonw 后会自行退出，但 pythonw 是常驻进程，
    # 使用 -Wait 会一直等到服务停止。这里启动后改为轮询健康检查。
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$service`"") `
        -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-App) { break }
    }
}

if (-not (Test-App)) {
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "联播夜读服务启动失败。`n`n请查看：data\logs\server.err.log`n或手动双击 启动.bat。",
            "联播夜读",
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Warning
        ) | Out-Null
    } catch { }
    exit 1
}

if (-not $NoBrowser) {
    Start-Process $appUrl
}
exit 0
