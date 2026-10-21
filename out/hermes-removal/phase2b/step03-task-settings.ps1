$ErrorActionPreference='Stop'
$names=@('ERVP_Orders_Bot_All_Order_Review','ERVP_Orders_Bot_Direct_Shopify')
$results=@()
foreach($name in $names){
 $t=Get-ScheduledTask -TaskName $name
 $i=Get-ScheduledTaskInfo -InputObject $t
 $results+=@{name=$name;state=[string]$t.State;enabled=$t.Settings.Enabled;multiple_instances=[string]$t.Settings.MultipleInstances;execution_time_limit=[string]$t.Settings.ExecutionTimeLimit;last_run=$i.LastRunTime.ToString('o');next_run=$i.NextRunTime.ToString('o');last_result=$i.LastTaskResult;action_executables=@($t.Actions|ForEach-Object{$_.Execute});action_workdirs=@($t.Actions|ForEach-Object{$_.WorkingDirectory})}
}
$service=New-Object -ComObject 'Schedule.Service';$service.Connect()
$running=@($service.GetRunningTasks(1)|Where-Object{$names -contains $_.Name}|ForEach-Object{@{name=$_.Name;instance_guid=$_.InstanceGuid;state=$_.State;engine_pid=$_.EnginePID;current_action=$_.CurrentAction}})
@{at=(Get-Date).ToUniversalTime().ToString('o');tasks=$results;running_instances=$running;read_only=$true}|ConvertTo-Json -Depth 8
