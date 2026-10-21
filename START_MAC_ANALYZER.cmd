@echo off
setlocal

set "HOST_EXE=%~dp0dist\MAC-Analyzer-Pro-Next-Host.exe"
if exist "%HOST_EXE%" goto use_packaged_host

set "APP_HTML=%~dp0dist\MAC-Analyzer-Pro-Next.html"
if not exist "%APP_HTML%" (
  echo Autonomous application was not found:
  echo "%APP_HTML%"
  echo Run pnpm build in this folder, then start this file again.
  exit /b 1
)

start "" "%APP_HTML%"
exit /b 0

:use_packaged_host
start "" /wait "%HOST_EXE%" --root "%~dp0."
exit /b %errorlevel%
