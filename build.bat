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
echo [1/5] Preparing verified build tools...
powershell -NoProfile -ExecutionPolicy Bypass -File "build\prepare-tools.ps1"
if errorlevel 1 goto :fail
set "WIN_NODE_DIR=%CD%\build\cache\node-v22.23.4-win-x64"
set "WIN_NODE=%WIN_NODE_DIR%\node.exe"
set "PATH=%WIN_NODE_DIR%;%PATH%"
set "FFMPEG_BIN=%CD%\build\cache\ffmpeg\bin"
where npm >nul 2>nul
if errorlevel 1 (
  echo   npm is not on PATH. Reinstall Node.js so npm is included and run build.bat again.
  goto :fail
)

echo [2/5] Installing exactly the locked npm dependencies...
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  echo   npm ci failed.
  goto :fail
)
echo [3/5] Using Node 22.23.4 and cached FFmpeg...

echo [4/5] Building dist\WatchParty\WatchParty.exe ...
set "DIST_EXE=dist\WatchParty\WatchParty.exe"
rem Delete the old dist exe so a silent build failure cannot look like a success.
if exist "!DIST_EXE!" del /q "!DIST_EXE!" >nul 2>nul
"!WIN_NODE!" build\build-windows.js "!WIN_NODE!" "!FFMPEG_BIN!"
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
rem Keep external tools, extensions and required notices with the new executable.
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; foreach ($folder in @('bin','extension','LICENSES')) { Copy-Item -LiteralPath (Join-Path 'dist\WatchParty' $folder) -Destination '.' -Recurse -Force }; foreach ($file in @('LICENSE','THIRD_PARTY_NOTICES.md','BUILD-MANIFEST.json')) { Copy-Item -LiteralPath (Join-Path 'dist\WatchParty' $file) -Destination $file -Force }"
if errorlevel 1 (
  echo   Could not install companion files. Copy the complete dist\WatchParty folder before running the new build.
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
