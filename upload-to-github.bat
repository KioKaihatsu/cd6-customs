@echo off
chcp 65001 >nul
title Upload to GitHub
cd /d "%~dp0"
echo ============================================================
echo   Step A: Upload the code to GitHub
echo ============================================================
echo.
echo  1) Open this page in your browser:  https://github.com/new
echo  2) Repository name: cd6-customs   (any name is OK)
echo  3) Choose Public. Do NOT check "Add a README" or .gitignore.
echo  4) Click "Create repository".
echo  5) Copy the URL shown (like https://github.com/USER/cd6-customs.git)
echo.
set /p REPOURL=Paste the repository URL here and press Enter: 
if "%REPOURL%"=="" ( echo URL is empty. Aborting. & pause & exit /b 1 )
git remote remove origin 2>nul
git remote add origin %REPOURL%
git branch -M main
echo.
echo Uploading... (a browser may open to sign in to GitHub)
git push -u origin main
if errorlevel 1 ( echo. & echo  [ERROR] Upload failed. See the message above. & pause & exit /b 1 )
echo.
echo ============================================================
echo   DONE! Code uploaded to GitHub.
echo   Next: deploy on Render (see DEPLOY.txt / the chat steps).
echo ============================================================
pause
