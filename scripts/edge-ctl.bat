@echo off
cd /d "%~dp0\.."
node "%~dp0edge-server-ctl.mjs" %*
