$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016'
$r=Join-Path $b 'reconcile-20261016'
$state=@{}
foreach($n in @('status.json','failure.json','verification.json','error-reconciliation.json')){if(Test-Path (Join-Path $r $n)){$state[$n]=Get-Content (Join-Path $r $n) -Raw|ConvertFrom-Json}}
[pscustomobject]@{at=(Get-Date -Format o);state=$state;processes=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -match 'hermes-final-20261016\\archive-reconcile\.py'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}});source_sha256=(Get-FileHash (Join-Path $b 'archive-reconcile.py')).Hash;files=@(Get-ChildItem $r -File|ForEach-Object {@{name=$_.Name;bytes=$_.Length}})}|ConvertTo-Json -Depth 10
