@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-mobile-access.ps1"
if errorlevel 1 pause
