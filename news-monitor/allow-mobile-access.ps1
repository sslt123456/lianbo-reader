$ErrorActionPreference = "Stop"
$ruleName = "联播夜读 8766 (LAN)"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "需要管理员权限，正在请求提升…" -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" `
        -Verb RunAs `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    exit
}

try {
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 8766 `
        -Profile Any `
        -Description "允许同一 Wi-Fi 下的手机/平板访问联播夜读" | Out-Null
    Write-Host ""
    Write-Host "手机访问已开放 ✔" -ForegroundColor Green
    Write-Host "  已允许局域网设备访问 TCP 8766 端口。"
    Write-Host "  现在可以用手机/平板扫描「手机访问」页面中的二维码。"
} catch {
    Write-Host "设置失败：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Read-Host "按回车关闭"
