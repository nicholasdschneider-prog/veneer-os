$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016';$r=Join-Path $b 'quiescent-20261021'
$state=@{}
foreach($n in @('status.json','failure.json','verification.json','quiescence.json')){if(Test-Path (Join-Path $r $n)){$state[$n]=Get-Content (Join-Path $r $n) -Raw|ConvertFrom-Json}}
$launch=if(Test-Path (Join-Path $b 'quiescent-launch-20261021.json')){Get-Content (Join-Path $b 'quiescent-launch-20261021.json') -Raw|ConvertFrom-Json}else{$null}
$p=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'hermes-final-20261016\\archive-quiescent\.py'}|ForEach-Object{@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name}})
@{at=(Get-Date).ToUniversalTime().ToString('o');state=$state;launch=$launch;processes=$p;source_sha256=(Get-FileHash (Join-Path $b 'archive-quiescent.py')).Hash;free_bytes=(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace;files=@(Get-ChildItem $r -File -ErrorAction SilentlyContinue|ForEach-Object{@{name=$_.Name;bytes=$_.Length}})}|ConvertTo-Json -Depth 14
