@echo off
setlocal
cd /d "%~dp0"
title Watch Party build

echo.
echo === Watch Party build ===
echo.
echo [1/4] Preparing verified build tools...
powershell -NoProfile -ExecutionPolicy Bypass -File "build\prepare-tools.ps1"
if errorlevel 1 goto fail
set "WIN_NODE=%CD%\build\cache\node-v22.23.4-win-x64\node.exe"
set "PATH=%CD%\build\cache\node-v22.23.4-win-x64;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Install Node.js with npm and run build.bat again.
  goto fail
)
echo [2/4] Installing locked dependencies...
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto fail

echo [3/4] Building the portable release...
"%WIN_NODE%" build\build-windows.js "%WIN_NODE%" "%CD%\build\cache\ffmpeg\bin"
if errorlevel 1 goto fail

echo [4/4] Installing into app and starting Watch Party...
powershell -NoProfile -ExecutionPolicy Bypass -File "build\install-local.ps1"
if errorlevel 1 goto fail
echo.
echo === BUILD SUCCESSFUL ===
echo Installed app: %CD%\app\WatchParty.exe
echo Portable release: %CD%\build\output\WatchParty
echo Reload the browser page to use the new web files.
pause
exit /b 0

:fail
echo.
echo === BUILD FAILED ===
echo The error is shown above. Your settings and history are not overwritten by the release.
pause
exit /b 1
