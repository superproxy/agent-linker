# 本机纯节点
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @("start"))
$Repo = Split-Path -Parent $PSScriptRoot
& node (Join-Path $Repo "scripts\local-node-ctl.mjs") @Rest
exit $LASTEXITCODE
