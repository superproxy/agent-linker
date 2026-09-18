# linkagent node 启停脚本（Windows PowerShell）
# 用法与 scripts/node.sh 相同：
#   scripts/node.ps1                       启动默认节点（若已在运行则提示）
#   scripts/node.ps1 start [name]          启动节点（可给实例名，支持本机多实例）
#   scripts/node.ps1 stop [name]           停止
#   scripts/node.ps1 restart [name]        重启
#   scripts/node.ps1 status [name]         查看状态（不带 name 列出全部实例）
#   scripts/node.ps1 log [name]            跟随日志
#   scripts/node.ps1 foreground [name]     前台运行（Ctrl-C 退出，开发用）
#
# 节点配置（环境变量，或写入 .runtime-state/node[-<name>].env，KEY=VALUE 每行一条）：
#   LINKAGENT_GATEWAY_URL    网关地址（默认 ws://127.0.0.1:8787）
#   LINKAGENT_GATEWAY_TOKEN  网关 token（网关开启 auth 时必填）
#   LINKAGENT_NODE_AGENTS    逗号分隔的 agent id（缺省上报默认 4 种）
#   LINKAGENT_NODE_ID        一般不填，首次连接由网关签发并持久化
# 命名实例会自动把 LINKAGENT_NODE_NAME 设为实例名（除非 env 文件已指定）。
#
# 注意：不要使用 $PidXxx 变量名，PowerShell 会把 $PID 解析成当前进程 id。
# 本文件需带 UTF-8 BOM；Windows PowerShell 5.1 否则会把中文后的 ASCII 引号吞掉。

param(
  [Parameter(Position = 0)]
  [string]$Command = "start",
  [Parameter(Position = 1)]
  [string]$Name = ""
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
$Repo = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Repo ".runtime-state"

if ($Name) {
  $Base = "node-$Name"
} else {
  $Base = "node"
}
$NodePidPath = Join-Path $StateDir "$Base.pid"
$NodeLogPath = Join-Path $StateDir "$Base.log"
$EnvFile = Join-Path $StateDir "$Base.env"

function Import-NodeEnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if (
      ($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) -or
      ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2)
    ) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path "Env:$key" -Value $val
  }
}

Import-NodeEnvFile $EnvFile

if ($Name) {
  if (-not $env:LINKAGENT_NODE_NAME) {
    $env:LINKAGENT_NODE_NAME = $Name
  }
  $env:LINKAGENT_NODE_STATE_DIR = Join-Path $StateDir "node-$Name"
}

function Get-StoredProcId {
  if (-not (Test-Path -LiteralPath $NodePidPath)) { return $null }
  $raw = (Get-Content -LiteralPath $NodePidPath -TotalCount 1 -ErrorAction SilentlyContinue)
  if (-not $raw) { return $null }
  $text = $raw.ToString().Trim()
  if ($text -notmatch '^\d+$') { return $null }
  return [int]$text
}

function Test-ProcAlive {
  param([int]$ProcId)
  return [bool](Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Test-NodeRunning {
  $procId = Get-StoredProcId
  if ($null -eq $procId) { return $false }
  return (Test-ProcAlive -ProcId $procId)
}

function Save-NodeProcId {
  param([int]$ProcId)
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Set-Content -LiteralPath $NodePidPath -Value "$ProcId" -Encoding ascii -NoNewline
}

function Stop-ProcessTree {
  param([int]$ProcId, [switch]$Force)
  if ($Force) {
    & taskkill.exe /PID $ProcId /T /F 2>$null | Out-Null
  } else {
    & taskkill.exe /PID $ProcId /T 2>$null | Out-Null
  }
}

function Get-InstanceLabel {
  if ($Name) { return $Name }
  return "default"
}

function Start-NodeBackground {
  if (Test-NodeRunning) {
    Write-Host "节点 $(Get-InstanceLabel) 已在运行 (pid $(Get-StoredProcId))"
    return 0
  }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (-not (Test-Path -LiteralPath $NodeLogPath)) {
    New-Item -ItemType File -Path $NodeLogPath | Out-Null
  }
  Write-Host "→ 后台启动节点 $(Get-InstanceLabel) ..."
  $cmdLine = "/c pnpm --filter @linkagent/backend node:connect >> `"$NodeLogPath`" 2>&1"
  $p = Start-Process -FilePath "cmd.exe" `
    -ArgumentList $cmdLine `
    -WorkingDirectory $Repo `
    -WindowStyle Hidden `
    -PassThru
  Save-NodeProcId -ProcId $p.Id
  Start-Sleep -Seconds 1
  if (Test-NodeRunning) {
    Write-Host "✅ 节点 $(Get-InstanceLabel) 已启动 (pid $(Get-StoredProcId)，日志 $NodeLogPath)"
    return 0
  }
  Write-Host "⚠️  节点启动失败，最近日志："
  if (Test-Path -LiteralPath $NodeLogPath) {
    Get-Content -LiteralPath $NodeLogPath -Tail 15 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $NodePidPath -Force -ErrorAction SilentlyContinue
  return 1
}

function Stop-NodeBackground {
  if (-not (Test-NodeRunning)) {
    Write-Host "节点 $(Get-InstanceLabel) 未在运行"
    Remove-Item -LiteralPath $NodePidPath -Force -ErrorAction SilentlyContinue
    return 0
  }
  $procId = Get-StoredProcId
  Stop-ProcessTree -ProcId $procId
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-NodeRunning)) { break }
    Start-Sleep -Seconds 1
  }
  if (Test-NodeRunning) {
    Stop-ProcessTree -ProcId $procId -Force
  }
  Remove-Item -LiteralPath $NodePidPath -Force -ErrorAction SilentlyContinue
  Write-Host "节点 $(Get-InstanceLabel) 已停止"
  return 0
}

function Show-NodeStatus {
  if ($Name) {
    if (Test-NodeRunning) {
      Write-Host "节点 $Name 运行中 pid=$(Get-StoredProcId)  日志 $NodeLogPath"
    } else {
      Write-Host "节点 $Name 未运行"
    }
    return 0
  }
  $found = $false
  Get-ChildItem -Path $StateDir -Filter "node*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
    $found = $true
    $n = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    $pRaw = (Get-Content -LiteralPath $_.FullName -TotalCount 1 -ErrorAction SilentlyContinue)
    $pText = if ($pRaw) { $pRaw.ToString().Trim() } else { "" }
    $alive = $false
    if ($pText -match '^\d+$') {
      $alive = Test-ProcAlive -ProcId ([int]$pText)
    }
    if ($alive) {
      Write-Host "运行中  $n  pid=$pText"
    } else {
      Write-Host "已停止  $n（残留 pid 文件）"
    }
  }
  if (-not $found) {
    Write-Host "无节点实例（.runtime-state 下无 pid 文件）"
  }
  return 0
}

function Show-NodeLog {
  if (-not (Test-Path -LiteralPath $NodeLogPath)) {
    Write-Host "暂无日志（节点 $(Get-InstanceLabel) 尚未启动过）"
    return 0
  }
  Get-Content -LiteralPath $NodeLogPath -Wait -Tail 10
  return 0
}

function Start-NodeForeground {
  Write-Host "→ 前台运行节点 $(Get-InstanceLabel)（Ctrl-C 停止）..."
  Set-Location -LiteralPath $Repo
  & pnpm --filter @linkagent/backend node:connect
  return $LASTEXITCODE
}

$exitCode = 0
switch ($Command.ToLowerInvariant()) {
  "start" { $exitCode = Start-NodeBackground }
  "stop" { $exitCode = Stop-NodeBackground }
  "restart" {
    Stop-NodeBackground | Out-Null
    $exitCode = Start-NodeBackground
  }
  "status" { $exitCode = Show-NodeStatus }
  "log" { $exitCode = Show-NodeLog }
  "foreground" { $exitCode = Start-NodeForeground }
  default {
    Write-Host "用法: $($MyInvocation.MyCommand.Name) {start|stop|restart|status|log|foreground} [name]"
    $exitCode = 1
  }
}
exit $exitCode
