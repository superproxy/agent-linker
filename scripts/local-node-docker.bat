@echo off
cd /d "%~dp0\.."
if "%~1"=="" (node scripts\local-node-docker-ctl.mjs start) else (node scripts\local-node-docker-ctl.mjs %*)
