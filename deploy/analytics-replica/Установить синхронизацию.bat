@echo off
setlocal
cd /d "%~dp0"
title Lady Stretch - install analytics sync agent
set "SERVER="
set /p SERVER=Old analytics server SSH address (for example root@203.0.113.10): 
if "%SERVER%"=="" goto failed
"%SystemRoot%\System32\OpenSSH\ssh.exe" -o ConnectTimeout=15 %SERVER% "mkdir -p /root/lady-analytics-replica-setup"
if errorlevel 1 goto failed
"%SystemRoot%\System32\OpenSSH\scp.exe" -o ConnectTimeout=15 agent.py install.py README.md %SERVER%:/root/lady-analytics-replica-setup/
if errorlevel 1 goto failed
"%SystemRoot%\System32\OpenSSH\ssh.exe" -t -o ConnectTimeout=15 %SERVER% "python3 -I -B /root/lady-analytics-replica-setup/install.py"
if errorlevel 1 goto failed
echo Sync agent installed. Open the portal: Analytics - Sync with the old portal.
pause
exit /b 0
:failed
echo Installation stopped. Save the output.
pause
exit /b 1
