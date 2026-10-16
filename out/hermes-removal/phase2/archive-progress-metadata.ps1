$ErrorActionPreference='Stop'
$b='C:\Users\nicho\backups\hermes-final-20261016'
$manifest=Join-Path $b 'manifest.jsonl'
$f=[IO.File]::Open($manifest,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try{$length=$f.Length}finally{$f.Dispose()}
$controller=Get-CimInstance Win32_Process -Filter 'ProcessId=19500'
[pscustomobject]@{at=(Get-Date -Format o);controller=if($controller){@{pid=$controller.ProcessId;created=$controller.CreationDate.ToString('o');parent=$controller.ParentProcessId;name=$controller.Name;expected_source_path=($controller.CommandLine -match [regex]::Escape((Join-Path $b 'archive-pc.py')))}}else{$null};source_sha256=(Get-FileHash (Join-Path $b 'archive-pc.py')).Hash;manifest_reported_bytes=(Get-Item $manifest).Length;manifest_open_stream_bytes=$length;free_bytes=(Get-PSDrive C).Free;archive_changed_by_probe=$false}|ConvertTo-Json -Depth 5
