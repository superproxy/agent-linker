# Local host-subdomain routing check (taskRouting: host)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$adminKey = (Get-Content .runtime-state\edge\apisix.admin-key -Raw).Trim()
$taskId = (Get-Content .runtime-state\ide-proxy\current-task -ErrorAction SilentlyContinue).Trim()
if (-not $taskId) { $taskId = 'default' }
$stem = $taskId.ToLower().Replace('_', '-')
$webHost = "${stem}-web.ide.localhost"
$port = (Get-Content .runtime-state\gateway\listen-port.json | ConvertFrom-Json).port

Write-Host "== APISIX task-wildcard-subdomain"
$wc = curl.exe -s -H "X-API-KEY: $adminKey" "http://127.0.0.1:9180/apisix/admin/routes/task-wildcard-subdomain"
if ($wc -match 'Key not found') { Write-Host "FAIL: missing wildcard route (server:restart with taskRouting host)" }
else { Write-Host "OK" }

Write-Host "`n== frpc.toml"
$frpc = Get-Content .runtime-state\ide-proxy\frpc.toml -Raw
if ($frpc -match 'type = "tcp"') { Write-Host "FAIL: still TCP (worker:restart -f .runtime-state/node.env)" }
elseif ($frpc -match 'customDomains') { Write-Host "OK"; Select-String -Path .runtime-state\ide-proxy\frpc.toml -Pattern 'customDomains' }
else { Write-Host "WARN: run worker with node.env and switch active task" }

Write-Host "`n== /api/edge"
curl.exe -s "http://127.0.0.1:$port/api/edge"

Write-Host "`n`n== HTTP Host=$webHost"
$c9080 = curl.exe -s -o NUL -w "%{http_code}" -H "Host: $webHost" "http://127.0.0.1:9080/"
$c7080 = curl.exe -s -o NUL -w "%{http_code}" -H "Host: $webHost" "http://127.0.0.1:7080/"
Write-Host "9080 status $c9080"
Write-Host "7080 status $c7080"
