@echo off
setlocal
cd /d "%~dp0"
title Lady Stretch - remove analytics sync agent
set "SERVER="
set /p SERVER=Old analytics server SSH address (for example root@203.0.113.10): 
if "%SERVER%"=="" goto failed
"%SystemRoot%\System32\OpenSSH\ssh.exe" -t -o ConnectTimeout=15 %SERVER% "python3 -I -B /opt/lady-analytics-replica/install.py --uninstall"
if errorlevel 1 goto failed
echo Sync agent removed. The old portal is not affected.
pause
exit /b 0
:failed
echo Removal stopped. Save the output.
pause
exit /b 1
