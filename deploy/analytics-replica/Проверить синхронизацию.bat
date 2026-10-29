@echo off
setlocal
cd /d "%~dp0"
title Lady Stretch - check analytics sync agent
set "SERVER="
set /p SERVER=Old analytics server SSH address (for example root@203.0.113.10): 
if "%SERVER%"=="" goto failed
"%SystemRoot%\System32\OpenSSH\ssh.exe" -t -o ConnectTimeout=15 %SERVER% "lady-analytics-replica --status; systemctl list-timers --no-pager lady-analytics-replica.timer; journalctl -u lady-analytics-replica.service --no-pager -n 30"
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Check stopped. Save the output.
pause
exit /b 1
