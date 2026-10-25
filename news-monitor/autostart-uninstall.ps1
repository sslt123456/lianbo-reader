$ErrorActionPreference = "SilentlyContinue"
$taskName = "联播夜读-每日新闻监控"
$removed = $false

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已删除计划任务：$taskName" -ForegroundColor Green
    $removed = $true
}

$startup = [Environment]::GetFolderPath("Startup")
$startupLnk = Join-Path $startup "联播夜读自动监控.lnk"
$oldVbs = Join-Path $startup "联播夜读自动监控.vbs"
if (Test-Path $startupLnk) {
    Remove-Item $startupLnk -Force
    Write-Host "已删除启动文件夹快捷方式：$startupLnk" -ForegroundColor Green
    $removed = $true
}
if (Test-Path $oldVbs) {
    Remove-Item $oldVbs -Force
    Write-Host "已删除旧的启动脚本：$oldVbs" -ForegroundColor Green
    $removed = $true
}

if (-not $removed) {
    Write-Host "没有找到已安装的开机自启项。" -ForegroundColor Yellow
} else {
    Write-Host "开机自动监控已关闭。当前正在运行的服务不会自动停止。" -ForegroundColor Gray
}
