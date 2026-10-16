$py=@'
import pathlib,json
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\hermes-agent')
spec={'cron/jobs.py':[(270,375)],'cron/scheduler.py':[(6900,6975)],'hermes_cli/gateway.py':[(1,1)]}
out={}
for n,spans in spec.items():
 p=r/n
 if p.exists():
  lines=p.read_text(encoding='utf8',errors='replace').splitlines()
  out[n]=[{'line':i+1,'code':lines[i]} for a,b in spans for i in range(a-1,min(b,len(lines)))]
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
