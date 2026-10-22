$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016';$dest=Join-Path $b 'archive-resume-reconcile.py';$journal=Join-Path $b 'resume-reconcile-launch-20261021.json'
if((Test-Path $journal) -or (Test-Path (Join-Path $b 'quiescent-resume-20261021'))){throw 'Prior reconciliation launch/state exists; inspect before action'}
if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match 'hermes-final-20261016\\archive-(?:quiescent|resume-reconcile)(?:-resume)?\.py'}).Count){throw 'Prior operator controller live'}
if((Get-FileHash $dest).Hash -ne 'C3E8E777C85896E12C906EAA671BD2C6A7DA06C2E156A7CF70C4AC1AC66FBACB'){throw 'Reconciler source mismatch'}
$r=@{at=(Get-Date).ToUniversalTime().ToString('o');source=$dest;source_sha256=(Get-FileHash $dest).Hash;state='launch_intent'}
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
$w=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('C:\Python314\python.exe '+$dest);CurrentDirectory=$b};$r.pid=$w.ProcessId;$r.return_value=$w.ReturnValue
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
if($w.ReturnValue -ne 0){throw 'WMI failed; inspect before retry'}
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($w.ProcessId)";$r.created=if($p){$p.CreationDate.ToString('o')}else{$null};$r.state='reconciling_not_refreshing'
$r|ConvertTo-Json|Set-Content $journal -Encoding UTF8
$r|ConvertTo-Json
