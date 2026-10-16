$ErrorActionPreference='Stop'
$root='C:\Users\nicho\AppData\Local\hermes'
$errors=@()
$cron=@()
$files=@(Get-Item "$root\cron\jobs.json" -ErrorAction SilentlyContinue)+@(Get-ChildItem "$root\profiles\*\cron\jobs.json" -ErrorAction SilentlyContinue)
foreach($f in $files){
 try {
  $doc=Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
  $jobs=if($null -ne $doc.jobs){@($doc.jobs)}else{@($doc)}
  foreach($j in $jobs){
   $cron+= [pscustomobject]@{file=$f.FullName;id=$j.id;name=$j.name;enabled=$j.enabled;schedule=$j.schedule;next_run_at=$j.next_run_at;last_run_at=$j.last_run_at}
  }
 }catch{$errors+='cron parse failed: '+$f.FullName}
}
$tasks=@(Get-ScheduledTask | Where-Object {$_.TaskName -match 'ERVP|OrderOps|Hermes|Dometic|Orders|MPHealth|dashboard|gateway|watchdog'} | ForEach-Object {
 $t=$_; $i=$t|Get-ScheduledTaskInfo
 # Arguments are deliberately withheld: arbitrary command strings can embed credentials.
 [pscustomobject]@{name=$t.TaskName;path=$t.TaskPath;state=[string]$t.State;enabled=$t.Settings.Enabled;last_run=[string]$i.LastRunTime;last_result=$i.LastTaskResult;next_run=[string]$i.NextRunTime;missed=$i.NumberOfMissedRuns;actions=@($t.Actions|ForEach-Object{@{execute=$_.Execute;working_directory=$_.WorkingDirectory;script_paths=@([regex]::Matches($_.Arguments,'[A-Za-z]:\\[^"\r\n]*?\.(?:ps1|cmd|vbs|py|exe)')|ForEach-Object{$_.Value})}});triggers=@($t.Triggers|ForEach-Object{@{type=$_.CimClass.CimClassName;enabled=$_.Enabled;start=$_.StartBoundary;interval=$_.Repetition.Interval;duration=$_.Repetition.Duration}})}
})
$startup=@()
foreach($dir in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup","$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp")){
 foreach($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)){
  $targets=@()
  if($f.Extension -in '.vbs','.cmd','.bat'){
   $s=Get-Content -LiteralPath $f.FullName -Raw
   $targets=@([regex]::Matches($s,'[A-Za-z]:\\[^"\r\n]*?\.(?:ps1|cmd|vbs|py|exe)')|ForEach-Object{$_.Value}|Select-Object -Unique)
  }
  $startup+=[pscustomobject]@{name=$f.Name;path=$f.FullName;bytes=$f.Length;modified=$f.LastWriteTimeUtc.ToString('o');active_extension=($f.Extension -in '.vbs','.cmd','.bat','.lnk','.exe');target_paths=$targets}
 }
}
$processes=@(Get-CimInstance Win32_Process | ForEach-Object {
 $p=$_; $cl=[string]$p.CommandLine; $profile=$null
 if($cl -match '(?:--profile|-p)\s+([\w-]+)'){$profile=$Matches[1]}
 [pscustomobject]@{pid=$p.ProcessId;parent_pid=$p.ParentProcessId;name=$p.Name;executable=$p.ExecutablePath;created=if($p.CreationDate){$p.CreationDate.ToString('o')}else{$null};hermes_related=($cl -match 'hermes|ervp|OrderOps|dometic');profile=$profile;script_paths=@([regex]::Matches($cl,'[A-Za-z]:\\[^"\r\n]*?\.(?:ps1|cmd|vbs|py)')|ForEach-Object{$_.Value});role=if($cl -match 'gateway run'){'gateway'}elseif($cl -match 'dashboard'){'dashboard'}else{$null}}
})
$drives=@(Get-CimInstance Win32_LogicalDisk|Select-Object DeviceID,DriveType,Size,FreeSpace,FileSystem,VolumeName)
$homeitems=@(Get-ChildItem 'C:\Users\nicho' -Force | Select-Object Name,PSIsContainer,Length,LastWriteTimeUtc)
[pscustomobject]@{captured=(Get-Date -Format o);host=$env:COMPUTERNAME;cron=$cron;tasks=$tasks;startup=$startup;processes=$processes;drives=$drives;home_items=$homeitems;errors=$errors}|ConvertTo-Json -Depth 12
