@echo off
cd /d "%~dp0\.."
set LINKAGENT_LOCAL_STACK_ENHANCE=1
if "%~1"=="" goto start_enhance
if /I "%~1"=="stop" goto plain
if /I "%~1"=="status" goto plain
if /I "%~1"=="restart" (
  node scripts\local-stack-ctl.mjs restart:enhance %2 %3 %4 %5
  exit /b %ERRORLEVEL%
)
:plain
node scripts\local-stack-ctl.mjs %*
exit /b %ERRORLEVEL%
:start_enhance
node scripts\local-stack-ctl.mjs start:enhance
exit /b %ERRORLEVEL%
