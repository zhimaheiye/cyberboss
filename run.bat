@echo off
title Cyberboss Shared Start
cd /d "%~dp0"

echo [Cyberboss] Waiting 30s for network to be ready...
timeout /t 30 /nobreak > nul

echo [Cyberboss] Cleaning stale PID files...
del /f /q "%USERPROFILE%\.cyberboss\logs\shared-wechat.pid" 2>nul

echo [Cyberboss] Starting...
npm run shared:start
pause
