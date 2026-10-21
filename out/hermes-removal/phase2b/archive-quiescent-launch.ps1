$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016';$dest=Join-Path $b 'archive-quiescent.py';$journal=Join-Path $b 'quiescent-launch-20261021.json'
if((Test-Path $journal) -or (Test-Path (Join-Path $b 'quiescent-20261021'))){throw 'Prior launch/status exists: inspect source before action'}
if((Get-FileHash $dest).Hash -ne 'E8B3E57274661D3F4214E5386B074AE280FF48C15A899C36BABA9424EFC51D4C'){throw 'Source hash mismatch'}
if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'hermes-final-20261016\\archive-(pc|reconcile|quiescent)\.py'}).Count){throw 'An archive controller is live; no launch'}
$r=@{started_at=(Get-Date).ToUniversalTime().ToString('o');source=$dest;source_sha256=(Get-FileHash $dest).Hash;state='launch_intent'}
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
$w=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('C:\Python314\python.exe '+$dest);CurrentDirectory=$b}
$r.return_value=$w.ReturnValue;$r.pid=$w.ProcessId;$r.state='launch_returned'
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
if($w.ReturnValue -ne 0){throw 'WMI launch failed; inspect source before retry'}
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($w.ProcessId)"
$r.created=if($p -and $p.CreationDate){$p.CreationDate.ToString('o')}else{$null};$r.state='started_not_verified'
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
$r|ConvertTo-Json
