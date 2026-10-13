# 本机 enhance 单机模式
param([Parameter(Position = 0)][string]$Command = "start")
$Repo = Split-Path -Parent $PSScriptRoot
$env:LINKAGENT_LOCAL_STACK_ENHANCE = "1"
$sub = switch ($Command) {
  "stop" { "stop" }
  "status" { "status" }
  "restart" { "restart:enhance" }
  default { "${Command}:enhance" }
}
& node (Join-Path $Repo "scripts\local-stack-ctl.mjs") $sub
exit $LASTEXITCODE
