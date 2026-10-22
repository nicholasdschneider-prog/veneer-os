$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=2992'
if(-not $p){@{already_absent=$true;stopped=$false}|ConvertTo-Json;exit}
$parent=Get-CimInstance Win32_Process -Filter 'ProcessId=7408'
@{pid=$p.ProcessId;created=$p.CreationDate.ToString('o');parent_id=$p.ParentProcessId;parent_name=$parent.Name;name=$p.Name;command_line=$p.CommandLine}|ConvertTo-Json
