@echo off
setlocal
cd /d "%~dp0"

if defined MAC_ANALYZER_PYTHON if exist "%MAC_ANALYZER_PYTHON%" goto use_configured_python
if exist "%~dp0.venv\Scripts\python.exe" goto use_project_python
where py >nul 2>nul
if not errorlevel 1 goto use_python_launcher
where python >nul 2>nul
if not errorlevel 1 goto use_python_command

echo Python 3 was not found. Close the optional server console to stop the host.
exit /b 1

:use_configured_python
"%MAC_ANALYZER_PYTHON%" "%~dp0scripts\optional_server_launcher.py" --root "%~dp0." --stop
exit /b %errorlevel%

:use_project_python
"%~dp0.venv\Scripts\python.exe" "%~dp0scripts\optional_server_launcher.py" --root "%~dp0." --stop
exit /b %errorlevel%

:use_python_launcher
py -3 "%~dp0scripts\optional_server_launcher.py" --root "%~dp0." --stop
exit /b %errorlevel%

:use_python_command
python "%~dp0scripts\optional_server_launcher.py" --root "%~dp0." --stop
exit /b %errorlevel%
