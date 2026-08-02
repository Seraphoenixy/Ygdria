@echo off
setlocal
cd /d "%~dp0"
title Ygdria Desktop Dev

rem Electron must run as the desktop runtime, not as the Node.js compatibility process.
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules" (
  echo [Ygdria] Dependencies are not installed.
  echo Run "corepack pnpm install" in this folder first, then start this script again.
  pause
  exit /b 1
)

echo [Ygdria] Starting the Electron development build...
echo [Ygdria] Close the Electron window or press Ctrl+C here to stop debugging.
echo.
call corepack pnpm --filter @ygdria/desktop dev

if errorlevel 1 (
  echo.
  echo [Ygdria] Development process exited with an error.
  pause
)
