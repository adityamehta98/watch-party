@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Watch Party build

rem Rebuilds WatchParty.exe from the source in this folder.
rem On first run it downloads a matching Windows node.exe and an ffmpeg build
rem into build\cache (reused on every later run). Output: dist\WatchParty\WatchParty.exe.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Install Node 22+ from https://nodejs.org and run build.bat again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo   npm is not on PATH. Reinstall Node.js so npm is included and run build.bat again.
  pause
  exit /b 1
)

if not exist "node_modules\esbuild" (
  echo   Installing npm dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo   npm install failed. & pause & exit /b 1 )
)

for /f "usebackq tokens=*" %%v in (`node -p "process.versions.node"`) do set "NODE_VER=%%v"
echo   Using Node v!NODE_VER!

set "CACHE=build\cache"
if not exist "%CACHE%" mkdir "%CACHE%"

set "WIN_NODE_DIR=%CACHE%\node-v!NODE_VER!-win-x64"
set "WIN_NODE=!WIN_NODE_DIR!\node.exe"
if not exist "!WIN_NODE!" (
  echo   Downloading matching Windows node.exe v!NODE_VER! ...
  if not exist "!WIN_NODE_DIR!" mkdir "!WIN_NODE_DIR!"
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v!NODE_VER!/win-x64/node.exe' -OutFile '!WIN_NODE!'"
  if errorlevel 1 ( echo   Could not download node.exe for v!NODE_VER!. & pause & exit /b 1 )
)

set "FFMPEG_DIR=%CACHE%\ffmpeg"
set "FFMPEG_BIN=!FFMPEG_DIR!\bin"
if not exist "!FFMPEG_BIN!\ffmpeg.exe" (
  echo   Downloading ffmpeg (shared Windows build) ...
  if exist "!FFMPEG_DIR!" rmdir /s /q "!FFMPEG_DIR!"
  set "FFMPEG_ZIP=%CACHE%\ffmpeg.zip"
  set "FFMPEG_EXTRACT=%CACHE%\ffmpeg-extract"
  if exist "!FFMPEG_EXTRACT!" rmdir /s /q "!FFMPEG_EXTRACT!"
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip' -OutFile '!FFMPEG_ZIP!'"
  if errorlevel 1 ( echo   Could not download ffmpeg. & pause & exit /b 1 )
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Force -LiteralPath '!FFMPEG_ZIP!' -DestinationPath '!FFMPEG_EXTRACT!'"
  if errorlevel 1 ( echo   Could not unzip ffmpeg. & pause & exit /b 1 )
  for /d %%d in ("!FFMPEG_EXTRACT!\ffmpeg-*") do move /y "%%d" "!FFMPEG_DIR!" >nul
  if not exist "!FFMPEG_BIN!\ffmpeg.exe" ( echo   ffmpeg archive layout changed; could not find bin\ffmpeg.exe. & pause & exit /b 1 )
  rmdir /s /q "!FFMPEG_EXTRACT!" >nul 2>nul
  del /q "!FFMPEG_ZIP!" >nul 2>nul
)

echo   Building WatchParty.exe ...
node build\build-windows.js "!WIN_NODE!" "!FFMPEG_BIN!"
if errorlevel 1 ( echo   Build failed. & pause & exit /b 1 )

echo.
echo   Build done:  %CD%\dist\WatchParty\WatchParty.exe

if exist "WatchParty.exe" (
  echo   Replacing the WatchParty.exe in this folder with the fresh build...
  taskkill /im WatchParty.exe /f >nul 2>nul
  rem Give Windows a moment to release the file lock after taskkill.
  powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul 2>nul
  copy /y "dist\WatchParty\WatchParty.exe" "WatchParty.exe" >nul
  if errorlevel 1 (
    echo   Could not overwrite WatchParty.exe (still in use?). Close its browser tab,
    echo   wait a few seconds, and copy dist\WatchParty\WatchParty.exe over it by hand.
    pause
    exit /b 1
  )
  echo   WatchParty.exe is now the fresh build. Starting it...
  start "" "%CD%\WatchParty.exe"
) else (
  echo.
  echo   No WatchParty.exe in this folder yet. Copy  dist\WatchParty\WatchParty.exe
  echo   next to refresh.bat and double-click it (or run refresh.bat).
)

echo.
pause
