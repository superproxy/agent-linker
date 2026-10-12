# 本机方案：edge + gateway + node（PM 重启 node 以拉起 serveWeb/frpc）
#   scripts/local-stack.ps1 start|stop|restart|status

param(
  [Parameter(Position = 0)]
  [string]$Command = "start"
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$Scripts = $PSScriptRoot
$Repo = Split-Path -Parent $Scripts

function Invoke-Step {
  param([string]$Label, [scriptblock]$Block)
  Write-Host "→ $Label"
  & $Block
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Command.ToLowerInvariant()) {
  'start' {
    Push-Location -LiteralPath $Repo
    try {
      Invoke-Step 'edge (frps + APISIX)' { node (Join-Path $Scripts 'edge-ctl.mjs') start }
      Invoke-Step 'gateway' { node (Join-Path $Scripts 'server-ctl.mjs') start }
      Invoke-Step 'node（含 IDE compose + frpc）' { pnpm --filter @linkagent/backend pm:restart node }
    } finally {
      Pop-Location
    }
  }
  'stop' {
    Push-Location -LiteralPath $Repo
    try {
      Invoke-Step 'node' { pnpm --filter @linkagent/backend pm:stop node }
      Invoke-Step 'gateway' { node (Join-Path $Scripts 'server-ctl.mjs') stop }
      Invoke-Step 'edge' { node (Join-Path $Scripts 'edge-ctl.mjs') stop }
    } finally {
      Pop-Location
    }
  }
  'restart' {
    & (Join-Path $Scripts 'local-stack.ps1') stop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & (Join-Path $Scripts 'local-stack.ps1') start
    exit $LASTEXITCODE
  }
  'status' {
    Push-Location -LiteralPath $Repo
    try {
      Write-Host '--- edge ---'
      node (Join-Path $Scripts 'edge-ctl.mjs') status
      Write-Host '--- gateway ---'
      node (Join-Path $Scripts 'server-ctl.mjs') status
      Write-Host '--- pm ---'
      pnpm --filter @linkagent/backend pm:status
    } finally {
      Pop-Location
    }
  }
  default {
    Write-Host '用法: local-stack.ps1 start|stop|restart|status'
    exit 1
  }
}
