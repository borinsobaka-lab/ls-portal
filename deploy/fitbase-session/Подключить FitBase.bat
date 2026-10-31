@echo off
setlocal
cd /d "%~dp0"
title FitBase - portal sign-in helper
rem Portal "Analytics": FitBase sign-in helper. Opens a browser window,
rem you sign in to FitBase yourself, the session goes to the portal.
set PY=
where py >/dev/null 2>/dev/null && set PY=py -3
if not defined PY where python >/dev/null 2>/dev/null && set PY=python
if not defined PY goto nopython
if not exist .env\Scripts\python.exe %PY% -m venv .env
if errorlevel 1 goto failed
.env\Scripts\python.exe -m pip install --disable-pip-version-check --quiet playwright
if errorlevel 1 goto failed
.env\Scripts\python.exe fitbase_session.py %*
if errorlevel 1 goto failed
pause
exit /b 0
:nopython
echo Python 3 is not installed. Install it from https://www.python.org/downloads/ (check "Add python.exe to PATH") and run this file again.
:failed
pause
exit /b 1
