# 构建本地聚合镜像 linkagent-node:local。
# 不经过 scripts/image-node.mjs。先打包 dist/linkagent-node，再打两层镜像。
#   powershell -File scripts/build-node.ps1

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

Write-Host "-> pack dist/linkagent-node"
& pnpm build:dist:node
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "-> build linkagent-code-server:local"
& docker build -t linkagent-code-server:local -f (Join-Path $Root "code-server\Dockerfile") (Join-Path $Root "code-server")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Ctx = Join-Path ([System.IO.Path]::GetTempPath()) ("linkagent-node-image-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path (Join-Path $Ctx "code-server") -Force | Out-Null
try {
  Copy-Item -Recurse -Force (Join-Path $Root "dist\linkagent-node") (Join-Path $Ctx "linkagent-node")
  Copy-Item -Force (Join-Path $Root "code-server\render-frpc.mjs") (Join-Path $Ctx "code-server\render-frpc.mjs")
  Copy-Item -Force (Join-Path $Root "code-server\entrypoint-bundle.sh") (Join-Path $Ctx "code-server\entrypoint-bundle.sh")
  Write-Host "-> build linkagent-node:local"
  & docker build -f (Join-Path $Root "code-server\Dockerfile.bundle") -t linkagent-node:local $Ctx
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $Ctx -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "image linkagent-node:local ready"
