$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=18704'
if($p){
 if($p.ExecutablePath -ne 'C:\Python314\python.exe' -or $p.CreationDate.ToString('o') -ne '2026-10-16T09:39:30.2561790-04:00'){throw 'Probe process identity mismatch'}
 if($p.CommandLine -notmatch "base64\.b64decode\('([A-Za-z0-9+/=]+)'\)"){throw 'Probe command format mismatch'}
 $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])).Replace("`r`n","`n").Trim()
 $sha=[Security.Cryptography.SHA256]::Create()
 $hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source)))).Replace('-','').ToLower()
 if($hash -ne 'd9d48bb33c822072f6ff4f6c5c6f342896b328aab3d47d858a3b9992796d25eb'){throw 'Probe source hash mismatch; no stop'}
 Stop-Process -Id 18704
}
[pscustomobject]@{at=(Get-Date -Format o);process_id=18704;purpose='Own read-only source scan cleanup after SSH timeout';source_sha256='d9d48bb33c822072f6ff4f6c5c6f342896b328aab3d47d858a3b9992796d25eb';still_running=[bool](Get-CimInstance Win32_Process -Filter 'ProcessId=18704');hermes_job_invoked=$false}|ConvertTo-Json
