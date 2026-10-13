@echo off
cd /d "%~dp0"
if "%~1"=="" (
  node ctl.mjs start
) else (
  node ctl.mjs %*
)
