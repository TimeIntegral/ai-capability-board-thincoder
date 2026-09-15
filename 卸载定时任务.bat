@echo off
rem 卸载计划任务（英文输出避免代码页问题）
schtasks /Delete /F /TN "AI-Capability-Board-Collect"
schtasks /Delete /F /TN "AI-Quota-Board-Collect" 2>nul
if errorlevel 1 (echo [INFO] Task not found or delete failed.) else (echo [OK] Task deleted.)
echo (Dashboard files and data are kept.)
pause
