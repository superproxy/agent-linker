# frps 与 APISIX 启停（Windows，与 scripts/edge.sh 对齐）
# 安装根：LINKAGENT_HOME，否则当前工作目录
#   scripts/edge.ps1 start|stop|restart|status|log|build
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
$env:LINKAGENT_HOME = $Install

$Runtime = Join-Path $Install ".runtime-state\edge"
$EdgeAssets = Join-Path $PSScriptRoot "ops-edge"
if (-not (Test-Path -LiteralPath $EdgeAssets)) {
  $EdgeAssets = Join-Path $PSScriptRoot "edge"
}
$ComposeFile = Join-Path $EdgeAssets "docker-compose.yaml"
$FrpsPidPath = Join-Path $Runtime "frps.pid"
$FrpsLogPath = Join-Path $Runtime "frps.log"
$FrpsErrLogPath = Join-Path $Runtime "frps.stderr.log"
$ApisixLogPath = Join-Path $Runtime "apisix.log"
$PrepareScript = Join-Path $PSScriptRoot "ops-edge-prepare.mjs"
if (-not (Test-Path -LiteralPath $PrepareScript)) {
  $PrepareScript = Join-Path $PSScriptRoot "edge-prepare.mjs"
}

$script:FrpsBin = ""
$script:FrpsConf = ""
$script:ComposeProject = "linkagent-edge"
$script:ComposeBin = ""
$script:ComposeStyle = "none"

function Invoke-EdgePrepare {
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $env:LINKAGENT_EDGE_DIR = $Runtime
  Push-Location -LiteralPath $Install
  try {
    $out = & node $PrepareScript 2>&1
    if ($LASTEXITCODE -ne 0) {
      if ($out) { Write-Host $out }
      throw "edge 配置准备失败 (exit $LASTEXITCODE)"
    }
    foreach ($line in ($out -split "`n")) {
      $text = $line.Trim()
      if (-not $text -or -not $text.Contains('=')) { continue }
      $eq = $text.IndexOf('=')
      $key = $text.Substring(0, $eq)
      $val = $text.Substring($eq + 1)
      switch ($key) {
        'frpsBin' { $script:FrpsBin = $val }
        'frpsConf' { $script:FrpsConf = $val }
        'composeProject' { $script:ComposeProject = $val }
        'composeBin' { $script:ComposeBin = $val }
        'composeStyle' { $script:ComposeStyle = $val }
      }
    }
  } finally {
    Pop-Location
  }
}

function Get-ComposeArgv {
  param([string[]]$ComposeArgs)
  $extra = [System.Collections.ArrayList]@()
  foreach ($a in $ComposeArgs) { [void]$extra.Add($a) }
  $wantPlain = ($extra -contains 'build') -and ($extra -notcontains '--progress')
  if ($script:ComposeStyle -eq 'plugin') {
    $head = @($script:ComposeBin, 'compose')
    if ($wantPlain) { $head += @('--progress', 'plain') }
    return $head + @('-p', $script:ComposeProject, '-f', $ComposeFile) + $extra
  }
  if ($script:ComposeStyle -eq 'standalone') {
    return @($script:ComposeBin, '-p', $script:ComposeProject, '-f', $ComposeFile) + $extra
  }
  return $null
}

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  $argv = Get-ComposeArgv -ComposeArgs $ComposeArgs
  if (-not $argv) {
    Write-Host '未找到 docker compose。请安装 Docker Desktop 或 docker-compose-plugin。'
    return 1
  }
  # pnpm / 嵌套 PowerShell 常无真实控制台，BuildKit 会报 failed to get console
  $env:COMPOSE_BAKE = 'false'
  $env:BUILDKIT_PROGRESS = 'plain'
  $exe = $argv[0]
  $argList = $argv[1..($argv.Length - 1)]
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $Install
  $escaped = ($argList | ForEach-Object {
    if ($_ -match '\s|"') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }) -join ' '
  $psi.Arguments = $escaped
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  return $proc.ExitCode
}

function Test-FrpsRunning {
  if (-not (Test-Path -LiteralPath $FrpsPidPath)) { return $false }
  $raw = Get-Content -LiteralPath $FrpsPidPath -TotalCount 1 -ErrorAction SilentlyContinue
  if (-not $raw) { return $false }
  $pidVal = 0
  if (-not [int]::TryParse($raw.ToString().Trim(), [ref]$pidVal)) { return $false }
  return [bool](Get-Process -Id $pidVal -ErrorAction SilentlyContinue)
}

function Start-Frps {
  if (-not $script:FrpsBin -or -not (Test-Path -LiteralPath $script:FrpsBin)) {
    Write-Host "未找到 frps：$($script:FrpsBin)"
    return 1
  }
  if (Test-FrpsRunning) {
    $pidText = Get-Content -LiteralPath $FrpsPidPath -TotalCount 1
    Write-Host "frps 已在运行 (pid $pidText)"
    return 0
  }
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  foreach ($log in @($FrpsLogPath, $FrpsErrLogPath)) {
    if (-not (Test-Path -LiteralPath $log)) {
      New-Item -ItemType File -Path $log | Out-Null
    }
  }
  # Start-Process 要求 stdout/stderr 指向不同文件
  $p = Start-Process -FilePath $script:FrpsBin `
    -ArgumentList @('-c', $script:FrpsConf) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $FrpsLogPath `
    -RedirectStandardError $FrpsErrLogPath `
    -PassThru
  Set-Content -LiteralPath $FrpsPidPath -Value "$($p.Id)" -Encoding ascii
  Write-Host "frps 已启动 pid=$($p.Id) 配置 $($script:FrpsConf)"
  return 0
}

function Stop-Frps {
  if (-not (Test-FrpsRunning)) {
    Remove-Item -LiteralPath $FrpsPidPath -Force -ErrorAction SilentlyContinue
    Write-Host 'frps 未在运行'
    return 0
  }
  $raw = Get-Content -LiteralPath $FrpsPidPath -TotalCount 1
  $pidVal = [int]$raw.ToString().Trim()
  Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $FrpsPidPath -Force -ErrorAction SilentlyContinue
  Write-Host 'frps 已停止'
  return 0
}

function Start-Apisix {
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $env:LINKAGENT_EDGE_DIR = $Runtime
  Push-Location -LiteralPath $Install
  try {
    $code = Invoke-Compose @('up', '-d')
    if ($code -ne 0) {
      Write-Host "APISIX 启动失败，日志 $ApisixLogPath"
      return $code
    }
    "APISIX compose up $(Get-Date -Format o)" | Add-Content -LiteralPath $ApisixLogPath
    Write-Host "APISIX 已提交启动，日志 $ApisixLogPath"
    return 0
  } finally {
    Pop-Location
  }
}

function Stop-Apisix {
  $env:LINKAGENT_EDGE_DIR = $Runtime
  Push-Location -LiteralPath $Install
  try {
    Invoke-Compose @('down') | Out-Null
    "APISIX compose down $(Get-Date -Format o)" | Add-Content -LiteralPath $ApisixLogPath
    Write-Host 'APISIX 已停止'
    return 0
  } finally {
    Pop-Location
  }
}

function Build-Apisix {
  if (-not (Test-Path -LiteralPath (Join-Path $EdgeAssets 'Dockerfile'))) {
    Write-Host '缺少 scripts/edge/Dockerfile 或 scripts/ops-edge/Dockerfile'
    return 1
  }
  Write-Host '→ 构建镜像 linkagent-apisix:local'
  $env:LINKAGENT_EDGE_DIR = $Runtime
  Push-Location -LiteralPath $Install
  try {
    return (Invoke-Compose @('build', 'apisix'))
  } finally {
    Pop-Location
  }
}

function Show-EdgeLog {
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  foreach ($f in @($FrpsLogPath, $FrpsErrLogPath, $ApisixLogPath)) {
    if (-not (Test-Path -LiteralPath $f)) {
      New-Item -ItemType File -Path $f | Out-Null
    }
  }
  Get-Content -LiteralPath $FrpsLogPath, $ApisixLogPath -Wait -Tail 80
}

$exitCode = 0
switch ($Command.ToLowerInvariant()) {
  'start' {
    Invoke-EdgePrepare
    $exitCode = Start-Frps
    if ($exitCode -eq 0) { $exitCode = Start-Apisix }
  }
  'stop' {
    Invoke-EdgePrepare
    Stop-Frps | Out-Null
    $exitCode = Stop-Apisix
  }
  'restart' {
    Invoke-EdgePrepare
    Stop-Frps | Out-Null
    Stop-Apisix | Out-Null
    $exitCode = Start-Frps
    if ($exitCode -eq 0) { $exitCode = Start-Apisix }
  }
  'status' {
    Invoke-EdgePrepare
    if (Test-FrpsRunning) {
      Write-Host "frps 运行中 pid=$(Get-Content -LiteralPath $FrpsPidPath -TotalCount 1)"
    } else {
      Write-Host 'frps 未运行'
    }
    $env:LINKAGENT_EDGE_DIR = $Runtime
    Push-Location -LiteralPath $Install
    try { Invoke-Compose @('ps') | Out-Null } finally { Pop-Location }
  }
  'log' { Show-EdgeLog; return }
  'build' {
    Invoke-EdgePrepare
    $exitCode = Build-Apisix
  }
  default {
    Write-Host '用法: edge.ps1 start|stop|restart|status|log|build'
    $exitCode = 1
  }
}
exit $exitCode
