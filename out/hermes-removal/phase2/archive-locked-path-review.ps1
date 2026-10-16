$ErrorActionPreference='Stop'
$root='C:\Users\nicho\backups\hermes-final-20261016'
$s=Get-Content "$root\robocopy-local-hermes.log" -Raw
$paths=@([regex]::Matches($s,'[A-Za-z]:\\[^\r\n]+')|ForEach-Object {$_.Value.Trim()}|Select-Object -Unique)
$metadata=@($paths|ForEach-Object {
 $p=$_
 if(Test-Path -LiteralPath $p -PathType Leaf){
  $f=Get-Item -LiteralPath $p
  $rel=$p.Substring('C:\Users\nicho\AppData\Local\hermes\'.Length)
  $dest=Join-Path "$root\mirror\local-hermes" $rel
  @{path=$p;bytes=$f.Length;modified=$f.LastWriteTimeUtc.ToString('o');archive_path=$dest;archive_exists=(Test-Path -LiteralPath $dest);archive_bytes=if(Test-Path -LiteralPath $dest){(Get-Item -LiteralPath $dest).Length}else{$null}}
 }else{@{log_path=$p;exists=$false}}
})
[pscustomobject]@{at=(Get-Date -Format o);error_code=33;paths=$metadata;no_retry_performed=$true}|ConvertTo-Json -Depth 8
