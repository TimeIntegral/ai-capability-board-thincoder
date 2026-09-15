@echo off
rem Resume quota alerts immediately (cancel mute)
cd /d "%~dp0"
node mute.mjs off
timeout /t 3 >nul
