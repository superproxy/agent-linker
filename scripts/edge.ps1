# 兼容文档：转发 edge-server-ctl.ps1
param(
  [Parameter(Position = 0)]
  [string]$Command = "start"
)
& "$PSScriptRoot\edge-server-ctl.ps1" @PSBoundParameters
exit $LASTEXITCODE
