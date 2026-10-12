@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Watch Party build

rem Rebuilds WatchParty.exe from the source in this folder.
rem Caches a matching Windows node.exe and an ffmpeg "shared" build under
rem build\cache (reused on every later run). After a successful build it
rem replaces the WatchParty.exe sitting next to this script and starts it.
rem Fresh output always lands at dist\WatchParty\WatchParty.exe.

echo.
echo === Watch Party build ===
echo.
echo [1/5] Checking prerequisites...
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Install Node 22+ from https://nodejs.org and run build.bat again.
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo   npm is not on PATH. Reinstall Node.js so npm is included and run build.bat again.
  goto :fail
)

echo [2/5] npm dependencies...
set "NEED_NPM="
if not exist "node_modules\esbuild" set "NEED_NPM=1"
if not exist "node_modules\postject" set "NEED_NPM=1"
if not exist "node_modules\hls.js" set "NEED_NPM=1"
if not defined NEED_NPM (
  echo   node_modules already has what the build needs; skipping npm install.
  goto :npm_done
)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo   npm install failed.
  goto :fail
)
:npm_done

echo [3/5] Preparing cached tools under build\cache ...
for /f "usebackq tokens=*" %%v in (`node -p "process.versions.node"`) do set "NODE_VER=%%v"
if "!NODE_VER!"=="" (
  echo   Could not read Node version. Is "node" on PATH?
  goto :fail
)
echo   Using Node v!NODE_VER!

set "CACHE=build\cache"
if not exist "%CACHE%" mkdir "%CACHE%"

set "WIN_NODE_DIR=%CACHE%\node-v!NODE_VER!-win-x64"
set "WIN_NODE=!WIN_NODE_DIR!\node.exe"
set "NODE_URL=https://nodejs.org/dist/v!NODE_VER!/win-x64/node.exe"
if exist "!WIN_NODE!" goto :node_done
echo   Downloading Windows node.exe v!NODE_VER! ...
if not exist "!WIN_NODE_DIR!" mkdir "!WIN_NODE_DIR!"
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_URL -OutFile $env:WIN_NODE" || goto :node_fail
goto :node_done
:node_fail
echo   Could not download node.exe for v!NODE_VER! from !NODE_URL!.
goto :fail
:node_done
echo   Cached Windows node.exe v!NODE_VER! ready.

set "FFMPEG_DIR=%CACHE%\ffmpeg"
set "FFMPEG_BIN=!FFMPEG_DIR!\bin"
set "FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip"
set "FFMPEG_ZIP=%CACHE%\ffmpeg.zip"
set "FFMPEG_EXTRACT=%CACHE%\ffmpeg-extract"
if exist "!FFMPEG_BIN!\ffmpeg.exe" goto :ffmpeg_done
echo   Downloading ffmpeg shared Windows build ...
if exist "!FFMPEG_DIR!" rmdir /s /q "!FFMPEG_DIR!"
if exist "!FFMPEG_EXTRACT!" rmdir /s /q "!FFMPEG_EXTRACT!"
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:FFMPEG_URL -OutFile $env:FFMPEG_ZIP" || goto :ffmpeg_dl_fail
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Force -LiteralPath $env:FFMPEG_ZIP -DestinationPath $env:FFMPEG_EXTRACT" || goto :ffmpeg_unzip_fail
for /d %%d in ("!FFMPEG_EXTRACT!\ffmpeg-*") do move /y "%%d" "!FFMPEG_DIR!" >nul
if not exist "!FFMPEG_BIN!\ffmpeg.exe" goto :ffmpeg_layout_fail
rmdir /s /q "!FFMPEG_EXTRACT!" >nul 2>nul
del /q "!FFMPEG_ZIP!" >nul 2>nul
goto :ffmpeg_done
:ffmpeg_dl_fail
echo   Could not download ffmpeg from !FFMPEG_URL!.
goto :fail
:ffmpeg_unzip_fail
echo   Could not unzip ffmpeg.
goto :fail
:ffmpeg_layout_fail
echo   ffmpeg archive layout changed; bin\ffmpeg.exe was not inside the download.
goto :fail
:ffmpeg_done
echo   Cached ffmpeg ready.

echo [4/5] Building dist\WatchParty\WatchParty.exe ...
set "DIST_EXE=dist\WatchParty\WatchParty.exe"
rem Delete the old dist exe so a silent build failure cannot look like a success.
if exist "!DIST_EXE!" del /q "!DIST_EXE!" >nul 2>nul
node build\build-windows.js "!WIN_NODE!" "!FFMPEG_BIN!"
if errorlevel 1 (
  echo   build\build-windows.js reported an error.
  goto :fail
)
if not exist "!DIST_EXE!" (
  echo   Build finished without an error, but !DIST_EXE! was not produced.
  goto :fail
)

echo [5/5] Installing the fresh exe ...
echo   New build: %CD%\!DIST_EXE!
if not exist "WatchParty.exe" goto :no_root_exe
echo   Replacing: %CD%\WatchParty.exe
taskkill /im WatchParty.exe /f >nul 2>nul
rem Give Windows a moment to release the file lock after taskkill.
timeout /t 2 /nobreak >nul
copy /y "!DIST_EXE!" "WatchParty.exe" >nul
if errorlevel 1 (
  echo   Could not overwrite WatchParty.exe. It may still be running:
  echo   close its browser tab, wait a few seconds and run build.bat again,
  echo   or copy !DIST_EXE! over it by hand.
  goto :fail
)
echo   Replaced. Starting WatchParty.exe ...
start "" "%CD%\WatchParty.exe"
goto :success
:no_root_exe
echo   No WatchParty.exe in this folder yet. Copy !DIST_EXE! next to refresh.bat
echo   and double-click it (or run refresh.bat).

:success
echo.
echo === BUILD SUCCESSFUL ===
echo   Fresh exe:  %CD%\!DIST_EXE!
if exist "WatchParty.exe" echo   Installed:  %CD%\WatchParty.exe
echo   Reload the Watch Party page in your browser so it picks up the new web files.
echo.
pause
exit /b 0

:fail
echo.
echo === BUILD FAILED ===
echo   The step above printed the reason. Scroll up if needed; this window stays open.
echo.
pause
exit /b 1
