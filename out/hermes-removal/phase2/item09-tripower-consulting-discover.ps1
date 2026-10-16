$ErrorActionPreference='Stop'
$b='C:\Users\nicho\AppData\Local\hermes\profiles\tripower-consulting'
$dirs=@('','state','sessions','cron')
[pscustomobject]@{at=(Get-Date -Format o);profile='tripower-consulting';directories=@($dirs|ForEach-Object {$d=Join-Path $b $_;if(Test-Path $d){@{relative=$_;entries=@(Get-ChildItem -LiteralPath $d|Select-Object -First 150|ForEach-Object {@{name=$_.Name;directory=$_.PSIsContainer;bytes=if(-not $_.PSIsContainer){$_.Length}else{$null};modified=$_.LastWriteTimeUtc.ToString('o')}})}}})}|ConvertTo-Json -Depth 7
