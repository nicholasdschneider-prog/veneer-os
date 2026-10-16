$ErrorActionPreference="Continue"
Write-Output ("NOW " + (Get-Date -Format o))
Write-Output "--- PROCESSES"
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "hermes" } | ForEach-Object { $cl=($_.CommandLine -replace "\s+"," "); "{0} {1} {2}" -f $_.ProcessId, $_.Name, $cl.Substring(0,[Math]::Min(170,$cl.Length)) }
Write-Output "--- SCHEDULED TASKS"
Get-ScheduledTask | Where-Object { $_.TaskName -match "ERVP|OrderOps|Hermes|Dometic|Orders|MPHealth|dashboard|gateway|watchdog" } | ForEach-Object { $i=$_ | Get-ScheduledTaskInfo; "{0} | {1} | last={2} result={3}" -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult }
Write-Output "--- STARTUP"
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" | Select-Object -ExpandProperty Name
Write-Output "--- CRON FILES"
Get-ChildItem C:\Users\nicho\AppData\Local\hermes -Recurse -Filter jobs.json -ErrorAction SilentlyContinue | ForEach-Object { $j=Get-Content $_.FullName -Raw | ConvertFrom-Json; $jobs=if($j.jobs){$j.jobs}else{$j}; $en=@($jobs | Where-Object { $_.enabled -eq $true }).Count; "{0} total={1} enabled={2}" -f $_.FullName, @($jobs).Count, $en }
Write-Output "--- DISK"
Get-PSDrive C | ForEach-Object { "free={0}GB used={1}GB" -f [math]::Round($_.Free/1GB,1), [math]::Round($_.Used/1GB,1) }
Write-Output "--- TOOLS"
foreach($c in "codex","git","python","node","tailscale") { $p=Get-Command $c -ErrorAction SilentlyContinue; if($p){"{0}: {1}" -f $c,$p.Source} else {"{0}: missing" -f $c} }
Write-Output "--- UPTIME"
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
