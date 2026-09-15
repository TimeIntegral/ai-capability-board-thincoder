@echo off
rem AI capability board - installer (scheduled task + desktop shortcut + notification app name)
rem Usage: double-click this file (or run: node tools\install.mjs)
rem Prefers the bundled portable Node (runtime\node.exe) so users without Node installed can still run it.
rem Kept pure ASCII on purpose - .bat files are read with the console codepage.
setlocal
cd /d "%~dp0"

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  set "NODE=node"
)

"%NODE%" "tools\install.mjs"
if errorlevel 1 (
  echo.
  echo [X] Install failed. If it says node was not found, either install Node.js ^(https://nodejs.org^)
  echo     or run:  node release\make-portable.mjs   from a machine that has it.
)

pause
