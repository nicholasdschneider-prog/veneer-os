$ErrorActionPreference='Stop'
$root='C:\Users\nicho\backups\hermes-final-20261016'
if(Test-Path -LiteralPath $root){Rename-Item -LiteralPath $root -NewName 'hermes-final-20261016.incomplete-0847'}
New-Item -ItemType Directory -Path $root|Out-Null
$p=Join-Path $root 'archive-pc.py'
[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String([Console]::In.ReadToEnd()))
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('C:\Python314\python.exe '+$p);CurrentDirectory=$root}
if($result.ReturnValue -ne 0){throw 'WMI archive launch failed'}
[pscustomobject]@{started_at=(Get-Date -Format o);pid=$result.ProcessId;destination=$root;script_sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash;status='started; not yet verified';note='PC-only baseline; held writers require a later final seal'}|ConvertTo-Json