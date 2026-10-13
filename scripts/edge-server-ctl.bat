@echo off
rem frps + APISIX（Windows）
cd /d "%~dp0\.."
node "%~dp0edge-server-ctl.mjs" %*
