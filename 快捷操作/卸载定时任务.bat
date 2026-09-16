@echo off
rem Complete cleanup; personal files are kept. ASCII for Windows codepages.
rem The program folder's name is NOT ASCII, so it is located by content.
setlocal
cd /d "%~dp0.."
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
set "PROG="
for /d %%D in ("*") do if exist "%%~fD\tools\uninstall.mjs" set "PROG=%%~fD"
if not defined PROG (
  echo [X] Cannot find the program folder ^(the one holding tools\uninstall.mjs^).
  pause
  exit /b 1
)
"%NODE%" "%PROG%\tools\uninstall.mjs"
pause
