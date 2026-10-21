$ErrorActionPreference='Stop'
$root='C:\Users\nicho\AppData\Local\hermes\profiles\accounting-migration'
$queue=@("$root\scripts\ensure-gateway.vbs","$root\gateway-service\Hermes_Gateway_accounting-migration.vbs")
$seen=@();$out=@()
while($queue.Count -gt 0 -and $seen.Count -lt 12){
 $p=$queue[0];$queue=@($queue|Select-Object -Skip 1)
 if($p -in $seen){continue};$seen+=,$p
 if(-not(Test-Path -LiteralPath $p)){$out+=@{path=$p;exists=$false};continue}
 $text=Get-Content -LiteralPath $p -Raw
 $paths=@([regex]::Matches($text,'[A-Za-z]:[\\/][^"\r\n]*?\.(?:py|ps1|cmd|vbs)')|ForEach-Object{$_.Value}|Select-Object -Unique)
 $out+=@{path=$p;exists=$true;sha256=(Get-FileHash -LiteralPath $p).Hash;referenced_paths=$paths;gateway_run=($text -match 'gateway\s+run');watchdog=($text -match 'gateway_watchdog|ensure-orders');business_terms=($text -match 'owner_policy|every_order_review|pending_reconciler')}
 foreach($target in $paths){if($target -like "$root*" -and $target -notin $seen){$queue+=,$target}}
}
@{at=(Get-Date).ToUniversalTime().ToString('o');sources=$out;read_only=$true}|ConvertTo-Json -Depth 7
