$ErrorActionPreference='Stop'
$pattern='ERVP_Orders_Bot_(?:Direct_Shopify|All_Order_Review)|production_owner_policy_cycle|run_production_owner_policy_cycle|run_every_order_review|every_order_review|all_order_review'
function Processes {
 $all=@(Get-CimInstance Win32_Process)
 $ids=@($all|Where-Object{[string]$_.CommandLine -match $pattern}|ForEach-Object{[uint32]$_.ProcessId})
 do {$old=$ids.Count;$ids=@($ids+@($all|Where-Object{$ids -contains [uint32]$_.ParentProcessId}|ForEach-Object{[uint32]$_.ProcessId})|Select-Object -Unique)}while($ids.Count -gt $old)
 @($all|Where-Object{$ids -contains [uint32]$_.ProcessId}|ForEach-Object{@{pid=$_.ProcessId;parent_pid=$_.ParentProcessId;created=$_.CreationDate.ToString('o');name=$_.Name;executable=$_.ExecutablePath;matched_source=([string]$_.CommandLine -match $pattern)}})
}

$j=Get-Content -LiteralPath 'C:\Users\nicho\backups\hermes-phase2b-20261021\step03\task-disable.json' -Raw|ConvertFrom-Json
$names=@('ERVP_Orders_Bot_Direct_Shopify','ERVP_Orders_Bot_All_Order_Review')
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect()
$running=@($svc.GetRunningTasks(1)|Where-Object{$names -contains $_.Name}|ForEach-Object{@{name=$_.Name;guid=$_.InstanceGuid;pid=$_.EnginePID}})
$tree=@(Processes)
$tasks=@($names|ForEach-Object{$t=Get-ScheduledTask -TaskName $_;$i=Get-ScheduledTaskInfo -InputObject $t;@{name=$_;enabled=$t.Settings.Enabled;state=[string]$t.State;last_run=$i.LastRunTime.ToString('o')}})
$launchers=@($names|ForEach-Object{$p='C:\Users\nicho\AppData\Local\hermes\services\'+$_+'-silent.vbs';$s=Get-Content -LiteralPath $p -Raw;@{path=$p;sha256=(Get-FileHash -LiteralPath $p).Hash;referenced_paths=@([regex]::Matches($s,'[A-Za-z]:[\\/][^"\r\n]*?\.(?:py|cmd|vbs)')|ForEach-Object{$_.Value})}})
@{at=(Get-Date).ToUniversalTime().ToString('o');tasks=$tasks;running_instances=$running;cycle_process_tree=$tree;drained=($running.Count -eq 0 -and $tree.Count -eq 0);launchers=$launchers;no_process_stop=$true}|ConvertTo-Json -Depth 10
