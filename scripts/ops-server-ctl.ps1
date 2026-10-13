# gateway / channels / node（安装根目录）
param(
  [Parameter(Position = 0)]
  [string]$Cmd = 'start',
  [Parameter(Position = 1)]
  [string]$Target = 'all'
)
Set-Location (Split-Path -Parent $PSScriptRoot)
$argsPm = @($Cmd, $Target)
if ($Cmd -eq 'status') { $argsPm = @('status') }
elseif ($Cmd -in @('logs', 'log')) { $argsPm = @('logs', $Target) }
elseif ($Cmd -in @('foreground', 'fg', 'run')) { $argsPm = @('foreground', $Target) }
& node bin/pm.mjs @argsPm
exit $LASTEXITCODE
