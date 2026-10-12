# linkagent gateway 启停脚本（Windows PowerShell）
# 仅管理 **当前安装根** 下的 gateway（不根据全局 8787 误判）
# 安装根：LINKAGENT_HOME，否则为 **当前工作目录**
#   scripts/server.ps1 start|stop|restart|status|log|foreground
#
# 本文件建议带 UTF-8 BOM，以便 Windows PowerShell 5.1 正确解析中文。

param(
  [Parameter(Position = 0)]
  [string]$Command = "start"
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$ScriptRepo = Split-Path -Parent $PSScriptRoot
if ($env:LINKAGENT_HOME -and $env:LINKAGENT_HOME.Trim()) {
  $Install = $env:LINKAGENT_HOME.Trim()
} else {
  $Install = (Get-Location).Path
}
$Install = (Resolve-Path -LiteralPath $Install).Path

$Repo = $ScriptRepo
if (Test-Path -LiteralPath (Join-Path $Install "pnpm-workspace.yaml")) {
  $Repo = $Install
}

$StateDir = Join-Path $Install ".runtime-state"
$GatewayPidPath = Join-Path $StateDir "server.pid"
$GatewayLogPath = Join-Path $StateDir "server.log"
$ResolvePortScript = Join-Path $PSScriptRoot "resolve-gateway-port.mjs"

function Get-GatewayPort {
  Push-Location -LiteralPath $Install
  try {
    $out = & node $ResolvePortScript 2>$null
    if ($out) { return [int]$out.ToString().Trim() }
  } finally {
    Pop-Location
  }
  return 8787
}

function Get-GatewayHostUrl {
  $port = Get-GatewayPort
  return "http://127.0.0.1:$port"
}

function Get-StoredProcId {
  if (-not (Test-Path -LiteralPath $GatewayPidPath)) { return $null }
  $raw = Get-Content -LiteralPath $GatewayPidPath -TotalCount 1 -ErrorAction SilentlyContinue
  if (-not $raw) { return $null }
  $text = $raw.ToString().Trim()
  if ($text -notmatch '^\d+$') { return $null }
  return [int]$text
}

function Test-ProcAlive {
  param([int]$ProcId)
  return [bool](Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Test-GatewayRunning {
  $procId = Get-StoredProcId
  if ($null -eq $procId) { return $false }
  return (Test-ProcAlive -ProcId $procId)
}

function Save-GatewayProcId {
  param([int]$ProcId)
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Set-Content -LiteralPath $GatewayPidPath -Value "$ProcId" -Encoding ascii -NoNewline
}

function Stop-ProcessTree {
  param([int]$ProcId, [switch]$Force)
  if ($Force) {
    & taskkill.exe /PID $ProcId /T /F 2>$null | Out-Null
  } else {
    & taskkill.exe /PID $ProcId /T 2>$null | Out-Null
  }
}

function Test-GatewayHealth {
  param([string]$BaseUrl)
  $url = "$BaseUrl/healthz"
  & curl.exe -sS -m 2 $url 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Start-GatewayBackground {
  if (Test-GatewayRunning) {
    $base = Get-GatewayHostUrl
    Write-Host "gateway 已在运行 (pid $(Get-StoredProcId)，安装根 $Install，${base}/v1)"
    return 0
  }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (-not (Test-Path -LiteralPath $GatewayLogPath)) {
    New-Item -ItemType File -Path $GatewayLogPath | Out-Null
  }
  $port = Get-GatewayPort
  Write-Host "→ 后台启动 gateway（安装根 $Install，期望端口 $port）..."
  $cmdLine = "/c pnpm --filter @linkagent/backend start >> `"$GatewayLogPath`" 2>&1"
  $p = Start-Process -FilePath "cmd.exe" `
    -ArgumentList $cmdLine `
    -WorkingDirectory $Repo `
    -WindowStyle Hidden `
    -PassThru
  Save-GatewayProcId -ProcId $p.Id
  for ($i = 0; $i -lt 25; $i++) {
    $base = Get-GatewayHostUrl
    if (Test-GatewayHealth -BaseUrl $base) {
      Write-Host "✅ gateway 已就绪：${base}/v1 （日志 $GatewayLogPath）"
      return 0
    }
    Start-Sleep -Seconds 1
  }
  Write-Host "⚠️  启动超时，最近日志："
  if (Test-Path -LiteralPath $GatewayLogPath) {
    Get-Content -LiteralPath $GatewayLogPath -Tail 15 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $GatewayPidPath -Force -ErrorAction SilentlyContinue
  return 1
}

function Stop-GatewayBackground {
  if (-not (Test-GatewayRunning)) {
    Write-Host "gateway 未在运行（安装根 $Install）"
    Remove-Item -LiteralPath $GatewayPidPath -Force -ErrorAction SilentlyContinue
    return 0
  }
  $procId = Get-StoredProcId
  Write-Host "→ 停止 gateway (pid $procId) ..."
  Stop-ProcessTree -ProcId $procId
  for ($i = 0; $i -lt 15; $i++) {
    if (-not (Test-GatewayRunning)) { break }
    Start-Sleep -Seconds 1
  }
  if (Test-GatewayRunning) {
    Stop-ProcessTree -ProcId $procId -Force
  }
  Remove-Item -LiteralPath $GatewayPidPath -Force -ErrorAction SilentlyContinue
  Write-Host "gateway 已停止"
  return 0
}

function Show-GatewayStatus {
  $base = Get-GatewayHostUrl
  if (Test-GatewayRunning) {
    Write-Host "运行中 pid=$(Get-StoredProcId)  install=$Install  url=${base}/v1"
  } else {
    Write-Host "未运行（安装根 $Install）"
  }
  return 0
}

function Show-GatewayLog {
  if (-not (Test-Path -LiteralPath $GatewayLogPath)) {
    Write-Host "暂无日志（尚未启动过）"
    return 0
  }
  Get-Content -LiteralPath $GatewayLogPath -Wait -Tail 15
  return 0
}

function Start-GatewayForeground {
  Write-Host "→ 前台运行 gateway（Ctrl-C 停止，安装根 $Install）..."
  Set-Location -LiteralPath $Repo
  & pnpm --filter @linkagent/backend start
  return $LASTEXITCODE
}

$exitCode = 0
switch ($Command.ToLowerInvariant()) {
  "start" { $exitCode = Start-GatewayBackground }
  "stop" { $exitCode = Stop-GatewayBackground }
  "restart" {
    Stop-GatewayBackground | Out-Null
    $exitCode = Start-GatewayBackground
  }
  "status" { $exitCode = Show-GatewayStatus }
  "log" { $exitCode = Show-GatewayLog }
  "foreground" { $exitCode = Start-GatewayForeground }
  default {
    Write-Host '用法: server.ps1 start|stop|restart|status|log|foreground'
    $exitCode = 1
  }
}
exit $exitCode
