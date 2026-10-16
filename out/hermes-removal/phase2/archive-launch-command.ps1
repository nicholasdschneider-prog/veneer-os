$ErrorActionPreference='Stop'
$root='C:\Users\nicho\backups\hermes-final-20261016'
if(Test-Path -LiteralPath $root){throw 'Archive destination exists: inspect before acting'}
New-Item -ItemType Directory -Path $root|Out-Null
$p=Join-Path $root 'archive-pc.py'
[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String([Console]::In.ReadToEnd()))
$process=Start-Process -FilePath 'C:\Python314\python.exe' -ArgumentList @($p) -RedirectStandardOutput (Join-Path $root 'archive.stdout.log') -RedirectStandardError (Join-Path $root 'archive.stderr.log') -WindowStyle Hidden -PassThru
[pscustomobject]@{started_at=(Get-Date -Format o);pid=$process.Id;destination=$root;script_sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash;status='started; not yet verified';note='PC-only baseline; held writers require a later final seal'}|ConvertTo-Json