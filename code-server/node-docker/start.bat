@echo off
cd /d "%~dp0"
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
node ctl.mjs %CMD%
