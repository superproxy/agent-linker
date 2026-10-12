@echo off
rem APISIX + frps（Windows 非开发 / 独立包）
cd /d "%~dp0\.."
node "%~dp0edge-ctl.mjs" %*
