$ErrorActionPreference='Stop'
$py=@'
import pathlib,json,re,shutil
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes')
paths=[r/'profiles'/'ervp-orders'/'scripts'/'run_order_completion_sync.ps1',r/'hermes-agent'/'hermes_cli'/'gateway.py',r/'hermes-agent'/'cron'/'jobs.py']
out={'free_bytes':shutil.disk_usage('C:/').free,'robocopy':shutil.which('robocopy'),'sources':[]}
for p in paths:
 if not p.exists():continue
 lines=p.read_text(encoding='utf8',errors='replace').splitlines()
 if p.name=='run_order_completion_sync.ps1':
  matches=[{'line':i,'paths':re.findall(r'[A-Za-z]:\\[^\s"\x27]+',s)} for i,s in enumerate(lines,1) if re.search(r'\.py|\.json|ledger|checkpoint|state',s,re.I)]
 else:
  keys=['.jobs.lock','def _jobs_lock_file','def stop','stop_gateway','shutdown','control.sock','stop_file','stop_requested','stop_request','stop_marker']
  matches=[{'line':i,'code':s[:200]} for i,s in enumerate(lines,1) if any(t in s for t in keys)]
 out['sources'].append({'path':str(p),'matches':matches[:70]})
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
