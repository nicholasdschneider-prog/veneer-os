$ErrorActionPreference='Continue'
$root='C:\Users\nicho\AppData\Local\hermes'
$paths=@('C:\Users\nicho\backups','C:\Users\nicho\HermesBrainOps','C:\Users\nicho\HermesLegacyData',"$root\backups", "$root\kanban\boards\nick-work",'C:\Users\nicho\.hermes','C:\Users\nicho\Downloads')
$dirs=@();$candidates=@()
foreach($p in $paths){
 if(Test-Path -LiteralPath $p){
  $dirs+=@{path=$p;children=@(Get-ChildItem -LiteralPath $p -Force|Select-Object Name,PSIsContainer,Length,LastWriteTimeUtc)}
  $candidates+=@(Get-ChildItem -LiteralPath $p -File -Recurse -Depth 4 -ErrorAction SilentlyContinue | Where-Object {($_.Name -match '2026.?10.?13|20261013|recover|procedure|kanban|backup') -and ($_.Extension -in '.zip','.gz','.tgz','.7z','.db','.sqlite','.sqlite3','.log','.txt','.json','.md')} | Select-Object FullName,Length,LastWriteTimeUtc)
 }
}
$code=@();$q=New-Object 'System.Collections.Generic.Queue[string]';$seen=@{}
$q.Enqueue("$root\services\Hermes_Brain_Backup-silent.vbs")
while($q.Count -gt 0 -and $seen.Count -lt 15){
 $p=$q.Dequeue();if($seen.ContainsKey($p)){continue};$seen[$p]=$true
 if(!(Test-Path -LiteralPath $p)){continue}
 $s=Get-Content -LiteralPath $p -Raw
 $refs=@([regex]::Matches($s,'[A-Za-z]:[\\/][^"''\r\n]*')|ForEach-Object{$_.Value}|Where-Object{$_ -notmatch '(?i)token|password|secret|credential'}|Select-Object -Unique)
 $relative=@([regex]::Matches($s,'["'']([^"''\r\n]*\.(?:log|ps1|py|zip|7z|db))["'']')|ForEach-Object{$_.Groups[1].Value}|Where-Object{$_ -notmatch '(?i)token|password|secret|credential'}|Select-Object -Unique)
 $code+=@{path=$p;path_references=$refs;relative_file_references=$relative;uses_robocopy=($s -match 'robocopy');uses_sqlite_backup=($s -match '\.backup\(');uses_compress_archive=($s -match 'Compress-Archive');uses_tar=($s -match '\btar\b')}
 foreach($r in $refs){if($r -match '^([^\r\n]+\.(?:ps1|py|cmd|vbs))$'){$q.Enqueue($r)}}
}
$logs=@(Get-ChildItem "$root\services","$root\logs",'C:\Users\nicho\HermesBrainOps' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue|Where-Object{$_.Name -match '(brain|backup)' -and $_.Extension -in '.log','.txt'}|Select-Object FullName,Length,LastWriteTimeUtc)
$shares=@(Get-SmbMapping -ErrorAction SilentlyContinue|Select-Object LocalPath,RemotePath,Status)
[pscustomobject]@{captured=(Get-Date -Format o);directories=$dirs;candidates=$candidates;backup_code_metadata=$code;log_candidates=$logs;smb_mappings=$shares}|ConvertTo-Json -Depth 9
