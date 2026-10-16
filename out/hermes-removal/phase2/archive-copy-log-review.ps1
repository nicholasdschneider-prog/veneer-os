$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016'
$r=[IO.File]::ReadAllBytes((Join-Path $b 'robocopy-local-hermes.log'))
[pscustomobject]@{at=(Get-Date -Format o);source_exists=(Test-Path (Join-Path $b 'archive-reconcile.py'));reconcile_dir_exists=(Test-Path (Join-Path $b 'reconcile-20261016'));log_ascii=[Text.Encoding]::UTF8.GetString($r);log_utf16=[Text.Encoding]::Unicode.GetString($r)}|ConvertTo-Json
