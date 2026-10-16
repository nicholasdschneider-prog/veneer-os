$py=@'
import pathlib,json,hashlib,re,datetime as dt
b=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\accounting-migration');o={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'files':[],'preservation':'Original accounting processed/state files remain intact. No monitor invocation or mailbox query.'}
p=b/'state'
if p.exists():
 for f in p.iterdir():
  if not f.is_file() or not re.search('account|processed|inbox',f.name,re.I) or re.search('auth|secret|token|credential|dpapi|\.env',f.name,re.I):continue
  raw=f.read_bytes();d={'path':str(f),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'mtime_ns':f.stat().st_mtime_ns}
  if f.suffix=='.json':
   j=json.loads(raw)
   if isinstance(j,dict):
    d['fields']={k:{'type':type(v).__name__,'count':len(v) if isinstance(v,(list,dict)) else None,'sha256':hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()} for k,v in j.items() if not re.search('auth|secret|token|credential',k,re.I)}
    d['safe_status']={k:v for k,v in j.items() if isinstance(v,(bool,int,float)) or k in ['checked_at','updated_at','last_success_at'] and isinstance(v,str) and len(v)<50 and re.fullmatch(r'[0-9TZ:.+\-]+',v)}
  o['files'].append(d)
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Accounting state capture failed'}
