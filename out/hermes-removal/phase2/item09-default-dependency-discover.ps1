$ErrorActionPreference='Stop'
$b='C:\Users\nicho\AppData\Local\hermes'
[pscustomobject]@{at=(Get-Date -Format o);directories=@('hermes-agent','hermes-agent\hermes_cli','hermes-agent\hermes_cli\commands','hermes-agent\gateway','gateway-service','profiles\default')|ForEach-Object {$d=Join-Path $b $_;@{path=$d;exists=(Test-Path $d);entries=if(Test-Path $d){@(Get-ChildItem $d|Select-Object -First 80|ForEach-Object {$_.Name})}else{@()}}}}|ConvertTo-Json -Depth 6
