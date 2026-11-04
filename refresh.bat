@echo off
setlocal
cd /d "%~dp0"
title Watch Party update
rem Starts Watch Party. If an update is waiting in the _update folder, installs it first.
if not exist "_update\WatchParty.part00" goto noupdate

echo.
echo   Closing Watch Party if it's running...
taskkill /im WatchParty.exe /f >nul 2>nul
timeout /t 2 /nobreak >nul

echo   Installing the Watch Party update (under a minute)...
if exist "_update\update.zip" del /q "_update\update.zip"
set PARTS="_update\WatchParty.part00"
if exist "_update\WatchParty.part01" set PARTS=%PARTS%+"_update\WatchParty.part01"
if exist "_update\WatchParty.part02" set PARTS=%PARTS%+"_update\WatchParty.part02"
copy /b %PARTS% "_update\update.zip" >nul
if errorlevel 1 goto joinfail
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath((Join-Path (Get-Location) '_update')); $target=[IO.Path]::GetFullPath((Join-Path $root 'new')); if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe update path' }; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }; Expand-Archive -LiteralPath '_update\update.zip' -DestinationPath $target"
if errorlevel 1 goto unzipfail
if not exist "_update\new\WatchParty.exe" goto unzipfail
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; foreach ($folder in @('bin','extension','LICENSES')) { $source=Join-Path '_update\new' $folder; if (Test-Path -LiteralPath $source -PathType Container) { Copy-Item -LiteralPath $source -Destination '.' -Recurse -Force } }; foreach ($file in @('LICENSE','THIRD_PARTY_NOTICES.md','BUILD-MANIFEST.json')) { $source=Join-Path '_update\new' $file; if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $file -Force } }"
if errorlevel 1 goto inuse
move /y "_update\new\WatchParty.exe" "WatchParty.exe" >nul
if errorlevel 1 goto inuse
rmdir /s /q "_update" >nul 2>nul
echo   Done.
echo.
echo   If the Watch Party Sync extension changed too, reload it once:
echo   open brave://extensions (or chrome://extensions) and click its round reload arrow.
echo.
start "" "%~dp0WatchParty.exe" %*
timeout /t 8 >nul
exit /b 0

:noupdate
if not exist "WatchParty.exe" goto noexe
rem Watch Party runs in the background (no window) and opens its page in your browser.
start "" "%~dp0WatchParty.exe" %*
exit /b 0

:noexe
echo   WatchParty.exe is missing from this folder.
pause
exit /b 1

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
echo   WatchParty.exe is still in use. Close its page in your browser, wait a minute, then run refresh.bat again.
pause
exit /b 1
