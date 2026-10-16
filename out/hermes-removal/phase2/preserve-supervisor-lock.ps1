$ErrorActionPreference='Stop'
$source='C:\Users\nicho\AppData\Local\hermes\services\dashboard\supervisor.lock'
$dest='C:\Users\nicho\backups\hermes-phase2-20261016\dashboard\supervisor.lock.final'
if(Test-Path -LiteralPath $dest){throw 'Custody file exists; inspect before any repeat copy'}
$f=Get-Item -LiteralPath $source
if($f.Length -ne 37){throw 'Supervisor lock metadata changed; inspect'}
$hash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
Copy-Item -LiteralPath $source -Destination $dest
if((Get-FileHash -LiteralPath $dest).Hash -ne $hash){throw 'Custody copy hash mismatch'}
[pscustomobject]@{at=(Get-Date -Format o);source=$source;destination=$dest;bytes=$f.Length;sha256=$hash;original_preserved=$true;archive_tree_changed=$false;note='Preserved after dashboard observation passed. Reconcile into archive only after its controller finishes.'}|ConvertTo-Json
