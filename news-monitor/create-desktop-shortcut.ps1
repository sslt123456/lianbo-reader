$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$openApp = Join-Path $root "open_app.py"
$iconDir = Join-Path $env:LOCALAPPDATA "Lianbo"
$icon = Join-Path $iconDir "lianbo-classic.ico"
$sourceIcon = Join-Path $root "assets\lianbo-classic.ico"
if (Test-Path $sourceIcon) {
    New-Item -ItemType Directory -Force $iconDir | Out-Null
    Copy-Item $sourceIcon $icon -Force
}
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "联播夜读.lnk"
$urlShortcutPath = Join-Path $desktop "联播夜读（直达）.url"

if (-not (Test-Path $openApp)) {
    Write-Host "找不到 open_app.py：$openApp" -ForegroundColor Red
    exit 1
}

# 找 Python / pythonw；优先用能 import lxml/bs4 的解释器，避免抓到别的 Python 后页面解析报错。
$candidates = @()
$localPython = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
if (Test-Path $localPython) { $candidates += $localPython }
$localVenv = Join-Path $root ".venv\Scripts\python.exe"
if (Test-Path $localVenv) { $candidates += $localVenv }
if ($env:DSH_BUNDLED_PYTHON -and (Test-Path $env:DSH_BUNDLED_PYTHON)) {
    $candidates += $env:DSH_BUNDLED_PYTHON
}
$bundled = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if (Test-Path $bundled) { $candidates += $bundled }
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) { $candidates += $pythonCmd.Source }

$python = $null
foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path $candidate)) { continue }
    & $candidate -c "import lxml, bs4" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
}
if (-not $python) {
    $python = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $python) {
    Write-Host "未找到 Python，无法创建快捷方式。" -ForegroundColor Red
    exit 1
}
$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

# 1) 主快捷方式：pythonw 直接运行轻量启动器，不经过隐藏 PowerShell
#    （部分杀毒软件会把“隐藏 PowerShell + Bypass”误判为可疑）
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonw
$shortcut.Arguments = "`"$openApp`""
$shortcut.WorkingDirectory = $root
$shortcut.Description = "打开联播夜读：每日新闻联播联动简报"
$shortcut.WindowStyle = 7
if (Test-Path $icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Save()

# 2) 备用直达快捷方式：不依赖启动器，杀毒软件误杀 .lnk 时仍可使用
$urlContent = @"
[InternetShortcut]
URL=http://127.0.0.1:8766/
IconFile=$icon
IconIndex=0
"@
[System.IO.File]::WriteAllText($urlShortcutPath, $urlContent, [System.Text.Encoding]::Default)

Write-Host ""
Write-Host "桌面快捷方式已重新生成 ✔" -ForegroundColor Green
Write-Host "  主快捷方式：$shortcutPath"
Write-Host "  直达备份：  $urlShortcutPath"
Write-Host ""
Write-Host "主快捷方式会先检查后台服务，必要时自动启动，然后打开浏览器。" -ForegroundColor Gray
Write-Host "如果安全软件仍拦截主快捷方式，可直接使用「联播夜读（直达）」。" -ForegroundColor Gray
