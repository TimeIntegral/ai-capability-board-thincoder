@echo off
rem AI capability board - first-run setup wizard (pick platforms, save API keys, install, verify)
rem Usage: double-click this file (or run: node tools\setup.mjs)
rem Prefers the bundled portable Node (runtime\node.exe) so users without Node installed can still run it.
rem Kept pure ASCII on purpose - .bat files are read with the console codepage.
setlocal
cd /d "%~dp0"

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  set "NODE=node"
)

"%NODE%" "tools\setup.mjs"
if errorlevel 1 (
  echo.
  echo [X] Setup did not finish. Your existing settings were kept and nothing was broken.
  echo     Just double-click this file again to retry.
  echo     If it says node was not found, either install Node.js ^(https://nodejs.org^)
  echo     or run:  node release\make-portable.mjs   from a machine that has it.
)

pause
