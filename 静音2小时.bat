@echo off
rem Mute quota alerts for 2 hours (run: double-click this file)
cd /d "%~dp0"
node mute.mjs 2h
timeout /t 3 >nul
