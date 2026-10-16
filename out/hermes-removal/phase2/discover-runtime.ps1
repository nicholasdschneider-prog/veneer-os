$ErrorActionPreference='Stop'
$py=@'
import pathlib,json,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes')
out={'sources':[],'profile_files':{},'mirror_launcher_targets':[]}
for base in [r/'hermes-agent'/'cron',r/'hermes-agent'/'gateway',r/'hermes-agent'/'hermes_cli']:
 if base.exists():
  for p in base.rglob('*.py'):
   if any(x in p.parts for x in ['venv','.venv','node_modules']):continue
   s=p.read_text(encoding='utf8',errors='replace')
   terms=['FileLock','flock','msvcrt','jobs.json','def disable','def stop','active_jobs','running_jobs','gateway.pid','SIGTERM','signal.signal']
   lines=[{'line':i,'code':v[:240]} for i,v in enumerate(s.splitlines(),1) if any(t in v for t in terms)]
   if lines:out['sources'].append({'path':str(p),'matches':lines[:55]})
for profile in ['cs-tim','ervp-dev2','accounting-sharon','tripower-consulting']:
 p=r/'profiles'/profile
 files=[]
 if p.exists():
  for sub in ['cron','state','logs','sessions']:
   d=p/sub
   if d.exists():
    for f in d.iterdir():
     if f.is_file():files.append({'path':str(f),'bytes':f.stat().st_size,'mtime':f.stat().st_mtime})
 out['profile_files'][profile]=files
p=r/'services'/'OrderOps_Order_Completion_Mirror-silent.vbs'
if p.exists():out['mirror_launcher_targets']=re.findall(r'[A-Za-z]:\\[^"\r\n]*?\.(?:ps1|cmd|py)',p.read_text(errors='replace'))
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
