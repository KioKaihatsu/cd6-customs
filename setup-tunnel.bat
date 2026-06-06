@echo off
chcp 65001 >nul
title Setup Fixed URL (one-time)
cd /d "%~dp0"
set "TUNNEL_NAME=custom-event"
if not exist cloudflared.exe (
  echo  [ERROR] cloudflared.exe not found.
  pause
  exit /b 1
)
echo ============================================================
echo    Fixed URL Setup  (run this only once)
echo ============================================================
echo.
echo  Requirement: your domain must be added to Cloudflare
echo  (its nameservers point to Cloudflare).
echo.
echo  [Step 1/4] Log in to Cloudflare
echo  Press a key, a browser will open. Select your domain and Authorize.
echo.
pause
cloudflared.exe tunnel login
if errorlevel 1 ( echo  [ERROR] Login failed. & pause & exit /b 1 )
echo.
echo  [Step 2/4] Create tunnel (reused if it already exists)
cloudflared.exe tunnel create %TUNNEL_NAME%
echo.
echo  [Step 3/4] Enter the hostname you want to use
echo  Example: customs.cd6.io   (a subdomain of your domain)
echo.
set /p HOSTNAME=Hostname: 
if "%HOSTNAME%"=="" ( echo  Hostname is empty. Aborting. & pause & exit /b 1 )
echo.
echo  [Step 4/4] Configure DNS for %HOSTNAME% ...
cloudflared.exe tunnel route dns --overwrite-dns %TUNNEL_NAME% %HOSTNAME%
if errorlevel 1 ( echo  [ERROR] DNS setup failed. Check hostname/domain. & pause & exit /b 1 )
python -c "import json;open('tunnel.json','w',encoding='utf-8').write(json.dumps({'tunnel':'%TUNNEL_NAME%','hostname':'%HOSTNAME%'}))"
echo.
echo ============================================================
echo   DONE!  From now on, just run start.bat and your fixed URL
echo   will be:   https://%HOSTNAME%
echo   (To revert to a temporary URL, delete tunnel.json)
echo ============================================================
echo.
pause
