$py=@'
import pathlib,re,json
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\scripts\inventory-sync-incident-router-wrapper.py');s=p.read_text(encoding='utf8');a=[]
for i,v in enumerate(s.splitlines(),1):
 if re.search(r'SCRIPT_DIR|LOG_PATH|ROUTER\s*=|log_event|stdout|returncode',v) and not re.search(r'token|secret|credential|auth',v,re.I):a.append({'line':i,'code':v[:240]})
print(json.dumps({'wrapper_metadata_source':a}))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$source=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))")|ConvertFrom-Json
$procs=@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -in 19500,18796}|ForEach-Object {@{pid=$_.ProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;read_bytes=$_.ReadTransferCount;write_bytes=$_.WriteTransferCount;user_time=$_.UserModeTime;kernel_time=$_.KernelModeTime}})
[pscustomobject]@{at=(Get-Date -Format o);archive_process_progress=$procs;source=$source;free_bytes=(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace}|ConvertTo-Json -Depth 8
