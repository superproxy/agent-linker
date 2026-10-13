@echo off
cd /d "%~dp0\.."
if "%~1"=="" (node scripts\local-stack-ctl.mjs start) else (node scripts\local-stack-ctl.mjs %*)
