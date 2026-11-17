@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo [FDEX] Node.js 24 or newer is required and was not found on PATH.
  pause
  exit /b 1
)

set "NODE_EXE=node"

curl -sf -m 2 --noproxy "*" -o nul http://127.0.0.1:4310/api/health
if not errorlevel 1 goto open

echo [FDEX] service not running, starting on http://127.0.0.1:4310 ...
start "FDEX Image Service" /min "%NODE_EXE%" server.js

set /a TRIES=0
:wait
timeout /t 1 >nul
curl -sf -m 2 --noproxy "*" -o nul http://127.0.0.1:4310/api/health
if not errorlevel 1 goto open
set /a TRIES+=1
if %TRIES% lss 20 goto wait

echo [FDEX] failed to start within 20s. Run "node server.js" in this folder to see the error.
pause
exit /b 1

:open
echo [FDEX] service is up: http://127.0.0.1:4310
start "" http://127.0.0.1:4310
exit /b 0
