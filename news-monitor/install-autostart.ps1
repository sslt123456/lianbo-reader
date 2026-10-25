$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$openApp = Join-Path $root "open_app.py"
$icon = Join-Path $root "assets\icon.ico"
$taskName = "联播夜读-每日新闻监控"

if (-not (Test-Path $openApp)) {
    Write-Host "找不到 open_app.py：$openApp" -ForegroundColor Red
    exit 1
}

# 优先使用与项目匹配的 pythonw，避免再经过隐藏 PowerShell
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
    Write-Host "未找到 Python，无法安装开机自启。" -ForegroundColor Red
    exit 1
}
$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$startup = [Environment]::GetFolderPath("Startup")
$startupLnk = Join-Path $startup "联播夜读自动监控.lnk"
$oldVbs = Join-Path $startup "联播夜读自动监控.vbs"

$action = New-ScheduledTaskAction `
    -Execute $pythonw `
    -Argument "`"$openApp`" --startup" `
    -WorkingDirectory $root
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerDaily = New-ScheduledTaskTrigger -Daily -At "19:25"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$installed = $false
try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger @($triggerLogon, $triggerDaily) `
        -Settings $settings `
        -Principal $principal `
        -Description "Windows 登录后在后台启动「联播夜读」，每天 19:25 兜底检查；服务启动后会自动补抓最新一期新闻联播。" `
        -Force | Out-Null
    $installed = $true
} catch {
    Write-Host "计划任务创建失败：$($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $installed) {
    # 无管理员权限时退回“启动”文件夹方案：直接指向 pythonw，不经过隐藏 PowerShell。
    if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLnk)
    $shortcut.TargetPath = $pythonw
    $shortcut.Arguments = "`"$openApp`" --startup"
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "联播夜读：登录后后台启动新闻监控"
    $shortcut.WindowStyle = 7
    if (Test-Path $icon) { $shortcut.IconLocation = "$icon,0" }
    $shortcut.Save()
    if (Test-Path $oldVbs) { Remove-Item $oldVbs -Force }
    Write-Host "已改用「启动」文件夹自启：" -ForegroundColor Green
    Write-Host "  $startupLnk"
    Write-Host "登录 Windows 后会在后台启动服务，不弹窗、不打开浏览器。" -ForegroundColor Gray
    exit 0
}

# 计划任务安装成功后，清理可能存在的旧启动文件夹条目
if (Test-Path $oldVbs) { Remove-Item $oldVbs -Force }
if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force }

$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ""
Write-Host "开机自动监控已安装 ✔" -ForegroundColor Green
Write-Host "  任务名称：$taskName"
Write-Host "  触发条件：当前用户登录时 + 每天 19:25 检查"
Write-Host "  启动方式：pythonw 后台运行，不弹窗、不打开浏览器"
Write-Host "  最近结果：$($info.LastTaskResult)"
Write-Host ""
Write-Host "服务运行后会在后台检测更新；若开机时已错过 19:35，会自动补抓最新一期。" -ForegroundColor Gray
Write-Host "卸载：双击运行 autostart-uninstall.ps1（或删除计划任务）" -ForegroundColor DarkGray
