@echo off
rem Mute quota alerts for 2 hours (run: double-click this file)
rem Prefers the bundled portable Node (runtime\node.exe) so users without Node installed can still run it.
rem The program folder's name is NOT ASCII, so it is located by content.
setlocal
cd /d "%~dp0.."

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  set "NODE=node"
)

set "PROG="
for /d %%D in ("*") do if exist "%%~fD\mute.mjs" set "PROG=%%~fD"
if not defined PROG (
  echo [X] Cannot find the program folder ^(the one holding mute.mjs^).
  pause
  exit /b 1
)
"%NODE%" "%PROG%\mute.mjs" 2h
timeout /t 3 >nul
