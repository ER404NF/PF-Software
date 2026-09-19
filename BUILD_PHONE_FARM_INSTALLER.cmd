@echo off
rem DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER.
rem Builds the installer from a source checkout. Ordinary users download the
rem finished Phone-Farm-^<version^>-arm64.pkg from GitHub Releases instead.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER
echo (users: download the ready-made installer from GitHub Releases)
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo This developer builder needs Node.js 20 or newer. Install Node.js, then run this file again.
  set "PF_EXIT=1"
) else (
  node "%~dp0BUILD_PHONE_FARM_INSTALLER.mjs" %*
  set "PF_EXIT=!ERRORLEVEL!"
)

if not "%PHONE_FARM_NO_PAUSE%"=="1" pause
exit /b !PF_EXIT!
