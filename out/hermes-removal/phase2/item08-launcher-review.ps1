$ErrorActionPreference='Stop'
$dir='C:\Users\nicho\AppData\Local\hermes\services\dashboard'
$f=Get-Item "$dir\dashboard_supervisor.vbs"
$py=@'
import pathlib,ast,json,re
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\services\dashboard\dashboard_supervisor.py');s=p.read_text(encoding='utf8');t=ast.parse(s)
o={'path':str(p),'process_control_calls':[{'line':n.lineno,'function':ast.unparse(n.func)} for n in ast.walk(t) if isinstance(n,ast.Call) and re.search(r'Popen|run|spawn|kill|terminate|wait',ast.unparse(n.func),re.I)],'relaunch_control_source':[{'line':i,'code':v[:220]} for i,v in enumerate(s.splitlines(),1) if re.search(r'stop.file|stop_event|shutdown|SIGTERM|signal.signal|restart|while True|supervisor.lock',v,re.I) and not re.search('credential|token|secret|password',v,re.I)][:45]}
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$source=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))")|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw 'Dashboard supervisor static review failed'}
[pscustomobject]@{at=(Get-Date -Format o);launcher=@{path=$f.FullName;bytes=$f.Length;sha256=(Get-FileHash $f.FullName).Hash;disabled_destination_exists=(Test-Path ($f.FullName+'.disabled-20261016'))};source=$source}|ConvertTo-Json -Depth 8
