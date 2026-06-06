@echo off
chcp 65001 >nul
title Custom Team Maker
cd /d "%~dp0"
echo.
echo   Starting Custom Team Maker ...
echo   (The admin page will open in your browser automatically)
echo.
set "PYEXE="
where py >nul 2>nul && set "PYEXE=py"
if not defined PYEXE ( where python >nul 2>nul && set "PYEXE=python" )
if not defined PYEXE ( where python3 >nul 2>nul && set "PYEXE=python3" )
if not defined PYEXE (
  echo  [ERROR] Python was not found.
  echo  Please install Python 3 from https://www.python.org/
  echo  and check "Add Python to PATH" during installation.
  echo.
  pause
  exit /b 1
)
echo   Using Python: %PYEXE%
echo.
%PYEXE% server.py
echo.
echo  Server stopped. You can close this window.
pause
