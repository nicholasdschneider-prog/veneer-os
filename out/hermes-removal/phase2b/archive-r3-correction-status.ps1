$ErrorActionPreference='Stop'
$r='C:\Users\nicho\backups\hermes-final-20261016\quiescent-r3-20261022'
@{at=(Get-Date).ToUniversalTime().ToString('o');correction_sha256=(Get-FileHash (Join-Path $r 'baseline-corrections.jsonl')).Hash;applications=@(Get-Content (Join-Path $r 'applied-corrections.jsonl')|ForEach-Object{$_|ConvertFrom-Json});final_seal=$false}|ConvertTo-Json -Depth 5
