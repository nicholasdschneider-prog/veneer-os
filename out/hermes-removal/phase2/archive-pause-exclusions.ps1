$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=5708'
$out=@()
if($p){
 if($p.Name -ne 'python.exe' -or $p.CommandLine -notmatch 'hermes-final-20261016\\archive-pc.py'){throw 'Archive process identity mismatch'}
 $children=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq 5708})
 Stop-Process -Id 5708
 $out+=@{pid=5708;created=$p.CreationDate.ToString('o');role='archive controller'}
 foreach($c in $children){
  if($c.Name -ne 'Robocopy.exe' -and $c.Name -ne 'robocopy.exe'){throw 'Unexpected archive child; inspect'}
  $fresh=Get-CimInstance Win32_Process -Filter "ProcessId=$($c.ProcessId)"
  if($fresh -and $fresh.CreationDate -eq $c.CreationDate){Stop-Process -Id $c.ProcessId;$out+=@{pid=$c.ProcessId;created=$c.CreationDate.ToString('o');role='archive copy'}}
 }
}
$root='C:\Users\nicho\backups\hermes-final-20261016'
$record=@{at=(Get-Date -Format o);state='paused_exclusion_review';stopped=$out;reason='Credential/config backup filename variants require broader metadata exclusions';no_files_deleted=$true}
$record|ConvertTo-Json -Depth 6|Set-Content -LiteralPath "$root\paused-exclusion-review.json" -Encoding UTF8
$record|ConvertTo-Json -Depth 6
