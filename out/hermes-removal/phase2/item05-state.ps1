$py=@'
import pathlib,json,hashlib,datetime as dt
roots=[pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes'),pathlib.Path(r'C:\Users\nicho\.hermes')];o={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'script_metadata':[],'state_candidates':[],'reply_delta_limit':'No helper invocation or mailbox read. Script has no file-writing calls or local cursor path; only retained local artifacts are inventoried.'}
for root in roots:
 p=root/'scripts'/'check_martine_reply.py'
 if p.exists():o['script_metadata'].append({'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 for rel in ['state','runtime','cron/output']:
  p=root/rel
  if not p.exists():continue
  for f in p.iterdir():
   if f.is_file() and ('martine' in f.name.lower() or 'ce772d25016e' in f.name.lower()):o['state_candidates'].append({'path':str(f),'bytes':f.stat().st_size,'mtime_ns':f.stat().st_mtime_ns,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Martine state metadata failed'}
