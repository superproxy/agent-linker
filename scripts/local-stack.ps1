# 本机完整栈（原生 PM）
param([Parameter(Position = 0)][string]$Command = "start")
$Repo = Split-Path -Parent $PSScriptRoot
& node (Join-Path $Repo "scripts\local-stack-ctl.mjs") $Command @args
exit $LASTEXITCODE
