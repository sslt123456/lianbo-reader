$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$infoPath = Join-Path $root "data\remote_url.json"

$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -like "*serveo.net*" } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        $stopped += 1
    }

Remove-Item $infoPath -Force -ErrorAction SilentlyContinue

if ($stopped -gt 0) {
    Write-Host "远程访问已关闭 ✔" -ForegroundColor Green
} else {
    Write-Host "当前没有运行中的远程隧道。" -ForegroundColor Yellow
}
Write-Host "本地服务不受影响，仍可继续使用。"
Start-Sleep -Seconds 1
