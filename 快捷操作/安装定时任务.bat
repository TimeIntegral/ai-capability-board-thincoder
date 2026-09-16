@echo off
rem AI capability board - installer (scheduled task + desktop shortcut + notification app name)
rem Usage: double-click this file
rem Prefers the bundled portable Node (runtime\node.exe) so users without Node installed can still run it.
rem Kept pure ASCII on purpose - .bat files are read with the console codepage. The program folder's
rem name is NOT ASCII, so it is located by content (the folder holding tools\install.mjs) instead
rem of being spelled out here.
setlocal
cd /d "%~dp0.."

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  set "NODE=node"
)

set "PROG="
for /d %%D in ("*") do if exist "%%~fD\tools\install.mjs" set "PROG=%%~fD"
if not defined PROG (
  echo [X] Cannot find the program folder ^(the one holding tools\install.mjs^).
  pause
  exit /b 1
)

"%NODE%" "%PROG%\tools\install.mjs"
if errorlevel 1 (
  echo.
  echo [X] Install failed. If it says node was not found, either install Node.js ^(https://nodejs.org^)
  echo     or use the ZIP package that includes the built-in runtime.
)

pause
