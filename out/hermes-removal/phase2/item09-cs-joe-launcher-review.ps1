$ErrorActionPreference='Stop'
$p='C:\Users\nicho\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Hermes_Gateway_cs-joe.vbs'
$s=Get-Content $p -Raw
[pscustomobject]@{at=(Get-Date -Format o);path=$p;sha256=(Get-FileHash $p).Hash;profile_joe=($s -match 'cs-joe');gateway_run=($s -match 'gateway\s+run');script_paths=@([regex]::Matches($s,'(?i)[A-Z]:\\[^"\r\n]+?\.(?:ps1|vbs|cmd|bat|py)')|ForEach-Object {$_.Value});held_profile_reference=($s -match '(?:--profile|-p)\s+(?:ervp-manager|ervp-orders|hermesops)(?:\s|$)')}|ConvertTo-Json -Depth 5
