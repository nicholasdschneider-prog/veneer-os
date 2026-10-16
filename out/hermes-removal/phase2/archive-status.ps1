$ErrorActionPreference='Stop'
$root='C:\Users\nicho\backups\hermes-final-20261016'
$status=@{}
foreach($name in @('status.json','failure.json','verification.json')){if(Test-Path "$root\$name"){$status[$name]=Get-Content "$root\$name" -Raw|ConvertFrom-Json}}
$procs=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'robocopy.exe' -or $_.CommandLine -match 'hermes-final-20261016\\archive-pc.py'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToString('o')}})
[pscustomobject]@{at=(Get-Date -Format o);status=$status;processes=$procs;stderr=if(Test-Path "$root\archive.stderr.log"){Get-Content "$root\archive.stderr.log" -Tail 15}else{$null};files=@(Get-ChildItem $root -File|ForEach-Object {@{name=$_.Name;bytes=$_.Length}})}|ConvertTo-Json -Depth 8
