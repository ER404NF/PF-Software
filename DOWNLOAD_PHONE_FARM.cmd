@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Phone Farm local installer builder needs Node.js 20 or newer. Install Node.js, then run this file again.
  set "PF_EXIT=1"
) else (
  node "%~dp0DOWNLOAD_PHONE_FARM.mjs" %*
  set "PF_EXIT=!ERRORLEVEL!"
)

if not "%PHONE_FARM_NO_PAUSE%"=="1" pause
exit /b !PF_EXIT!
