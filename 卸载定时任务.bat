@echo off
rem Complete cleanup; personal files are kept. ASCII for Windows codepages.
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" "tools\uninstall.mjs"
pause
