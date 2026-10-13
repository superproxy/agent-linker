param(
  [Parameter(Position = 0)]
  [string]$Command = "start"
)
& "$PSScriptRoot\edge-server-ctl.ps1" @PSBoundParameters
exit $LASTEXITCODE
