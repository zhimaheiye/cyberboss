@echo off
setlocal
cd /d "%~dp0"
title CyberBoss Local Workspace
if not exist "third_party\opentodo\v1.4.2\opentodo-windows-amd64.exe" (
  call npm run desktop:install
  if errorlevel 1 goto failed
)
call npm run desktop
:failed
if errorlevel 1 pause
endlocal
