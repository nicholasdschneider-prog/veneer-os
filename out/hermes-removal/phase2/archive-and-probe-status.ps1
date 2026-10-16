$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process)
$procs=@($all|Where-Object {$_.ProcessId -in 19500,18796}|ForEach-Object {@{pid=$_.ProcessId;name=$_.Name;created=$_.CreationDate.ToString('o');read_bytes=$_.ReadTransferCount;write_bytes=$_.WriteTransferCount}})
$probes=@($all|Where-Object {$_.ExecutablePath -eq 'C:\Python314\python.exe' -and $_.CommandLine -match 'import base64;exec'}|ForEach-Object {@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToString('o')}})
[pscustomobject]@{at=(Get-Date -Format o);archive=$procs;remaining_encoded_python_probes=$probes;free_bytes=(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace}|ConvertTo-Json -Depth 6
