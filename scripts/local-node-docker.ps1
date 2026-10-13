# Docker 聚合节点
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @("start"))
$Repo = Split-Path -Parent $PSScriptRoot
& node (Join-Path $Repo "scripts\local-node-docker-ctl.mjs") @Rest
exit $LASTEXITCODE
