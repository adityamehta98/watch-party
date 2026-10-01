@echo off
setlocal
cd /d "%~dp0"

rem ---- one-time: install an update from the _update folder, if there is one ----
if not exist "_update\WatchParty.part00" goto start
title Watch Party update
echo.
echo   Installing the Watch Party update (one time, under a minute)...
copy /b "_update\WatchParty.part00"+"_update\WatchParty.part01" "_update\update.zip" >nul
if errorlevel 1 goto joinfail
powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '_update\update.zip' -DestinationPath '_update\new'"
if not exist "_update\new\WatchParty.exe" goto unzipfail
move /y "_update\new\WatchParty.exe" "WatchParty.exe" >nul
if errorlevel 1 goto inuse
rmdir /s /q "_update" >nul 2>nul

:start
if not exist "WatchParty.exe" goto noexe
rem Watch Party runs in the background (no window) and opens its page in your browser.
start "" "%~dp0WatchParty.exe" %*
exit /b 0

:joinfail
echo   Some update files are missing from the _update folder.
pause
exit /b 1

:unzipfail
echo   Could not unzip the update. Right-click _update\update.zip, choose Extract All,
echo   and extract it into this folder (replace WatchParty.exe).
pause
exit /b 1

:inuse
echo   Watch Party is still running. Close its page in your browser, wait a minute, then run this again.
pause
exit /b 1

:noexe
echo   WatchParty.exe is missing from this folder.
pause
exit /b 1
