# 本机栈：默认原生（edge + gateway + channels + PM node + 宿主机 frpc）
# enhance = edge 增强 + 单机模式（PM node + code-server 容器 + 宿主机 frpc）
# enhance:docker = edge 增强 + Docker 模式（linkagent-node 聚合容器）
#   scripts/local-stack.ps1 start|stop|restart|status|enhance

param(
  [Parameter(Position = 0)]
  [string]$Command = "start",
  [switch]$Enhance,
  [switch]$EnhanceDocker
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$Scripts = $PSScriptRoot
$Repo = Split-Path -Parent $Scripts

if ($Command -match '^(.+):enhance:docker$') {
  $Command = $Matches[1]
  $EnhanceDocker = $true
} elseif ($Command -match '^(.+):enhance$') {
  $Command = $Matches[1]
  $Enhance = $true
} elseif ($Command -eq 'enhance') {
  $Enhance = $true
  $Command = 'start'
} elseif ($Command -eq 'enhance:docker') {
  $EnhanceDocker = $true
  $Command = 'start'
}

function Invoke-Step {
  param([string]$Label, [scriptblock]$Block)
  Write-Host "→ $Label"
  & $Block
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Start-NodeLayer {
  param(
    [ValidateSet('native', 'enhance', 'enhance-docker')]
    [string]$NodeMode = 'native'
  )
  if ($NodeMode -eq 'enhance-docker') {
    Remove-Item Env:LINKAGENT_LOCAL_STACK_ENHANCE -ErrorAction SilentlyContinue
    Invoke-Step 'Docker 模式：停止单机 PM node' {
      pnpm --filter @linkagent/backend pm:stop node 2>$null
      exit 0
    }
    Invoke-Step 'Docker 模式：停止单机 code-server 容器' {
      docker compose -f (Join-Path $Repo '.runtime-state/ide-proxy/compose.yml') down 2>$null
      exit 0
    }
    Invoke-Step 'Docker 模式：启动 linkagent-node' { pnpm node:docker }
    return
  }
  if ($NodeMode -eq 'enhance') {
    $env:LINKAGENT_LOCAL_STACK_ENHANCE = '1'
    Invoke-Step '单机模式：PM node + code-server（8010）' {
      pnpm image:code-server 2>$null
      pnpm --filter @linkagent/backend pm:restart node
    }
  } else {
    Remove-Item Env:LINKAGENT_LOCAL_STACK_ENHANCE -ErrorAction SilentlyContinue
    Invoke-Step 'node（原生 PM + 宿主机 frpc）' { pnpm --filter @linkagent/backend pm:restart node }
  }
  $stopDockerLabel = if ($NodeMode -eq 'enhance') {
    '单机模式：停止 Docker 模式节点（若存在）'
  } else {
    '停止 Docker 模式节点（若存在）'
  }
  Invoke-Step $stopDockerLabel { pnpm node:docker:stop 2>$null; exit 0 }
}

switch ($Command.ToLowerInvariant()) {
  'start' {
    Push-Location -LiteralPath $Repo
    try {
      if ($Enhance -or $EnhanceDocker) {
        if ($EnhanceDocker) { $env:LINKAGENT_STACK_VERIFY_MODE = 'enhance-docker' }
        else { $env:LINKAGENT_STACK_VERIFY_MODE = 'enhance' }
        Invoke-Step 'edge + gateway enhance' { node (Join-Path $Scripts 'dev-local-stack-edge-enhance.mjs') }
      } else {
        Remove-Item Env:LINKAGENT_STACK_VERIFY_MODE -ErrorAction SilentlyContinue
        Invoke-Step 'edge (frps + APISIX)' { node (Join-Path $Scripts 'edge-ctl.mjs') start }
        Invoke-Step 'gateway' { node (Join-Path $Scripts 'dev-server-ctl.mjs') start }
      }
      Invoke-Step 'channels（PM channel-gateway）' { pnpm --filter @linkagent/backend pm:restart channels }
      $nodeMode = if ($EnhanceDocker) { 'enhance-docker' } elseif ($Enhance) { 'enhance' } else { 'native' }
      Start-NodeLayer -NodeMode $nodeMode
    } finally {
      Pop-Location
    }
  }
  'stop' {
    Push-Location -LiteralPath $Repo
    try {
      Remove-Item Env:LINKAGENT_LOCAL_STACK_ENHANCE -ErrorAction SilentlyContinue
      Invoke-Step '停止 node 相关 Docker（单机 IDE / Docker 模式）' {
        pnpm node:docker:stop 2>$null
        docker compose -f (Join-Path $Repo '.runtime-state/ide-proxy/compose.yml') down 2>$null
        exit 0
      }
      Invoke-Step 'PM node' { pnpm --filter @linkagent/backend pm:stop node }
      Invoke-Step 'channels' { pnpm --filter @linkagent/backend pm:stop channels }
      Invoke-Step 'gateway' { node (Join-Path $Scripts 'dev-server-ctl.mjs') stop }
      Invoke-Step 'edge' { node (Join-Path $Scripts 'edge-ctl.mjs') stop }
    } finally {
      Pop-Location
    }
  }
  'restart' {
    & (Join-Path $Scripts 'local-stack.ps1') stop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($EnhanceDocker) {
      & (Join-Path $Scripts 'local-stack.ps1') start -EnhanceDocker
    } elseif ($Enhance) {
      & (Join-Path $Scripts 'local-stack.ps1') start -Enhance
    } else {
      & (Join-Path $Scripts 'local-stack.ps1') start
    }
    exit $LASTEXITCODE
  }
  'status' {
    Push-Location -LiteralPath $Repo
    try {
      Write-Host '--- edge ---'
      node (Join-Path $Scripts 'edge-ctl.mjs') status
      Write-Host '--- gateway ---'
      node (Join-Path $Scripts 'dev-server-ctl.mjs') status
      Write-Host '--- pm（gateway / channels / node）---'
      pnpm --filter @linkagent/backend pm:status
      Write-Host '--- 单机 IDE / Docker 模式节点 ---'
      docker ps --filter name=linkagent-code-serve-web --filter name=linkagent-node --format 'table {{.Names}}\t{{.Status}}' 2>$null
      Write-Host '--- 启动方式验证 ---'
      if ($Enhance -or $env:LINKAGENT_LOCAL_STACK_ENHANCE -eq '1') {
        $env:LINKAGENT_STACK_VERIFY_MODE = 'enhance'
      } else {
        Remove-Item Env:LINKAGENT_STACK_VERIFY_MODE -ErrorAction SilentlyContinue
      }
      node (Join-Path $Scripts 'dev-verify-stack.mjs')
    } finally {
      Pop-Location
    }
  }
  default {
    Write-Host '用法: local-stack.ps1 start|start:enhance|start:enhance:docker|stop|restart|status'
    Write-Host '      local-stack.ps1 start -Enhance | start -EnhanceDocker'
    exit 1
  }
}
