$py=@'
import pathlib,json,hashlib,datetime as dt,re,sys
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager');out={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'files':[]}
# Local logs only. Preserve identifiers/counts and schema, never incident/customer bodies.
def safe(d):
 if isinstance(d,list):return {'count':len(d)}
 if not isinstance(d,dict):return None
 x={}
 for k,v in d.items():
  if re.search(r'body|message|subject|email|name|description|error|token|secret|auth',k,re.I):continue
  if isinstance(v,(bool,int,float)) or v is None:x[k]=v
  elif isinstance(v,list):x[k]={'count':len(v)}
  elif isinstance(v,dict):x[k]=safe(v)
  elif isinstance(v,str) and re.search(r'^(?:status|event|type|mode|reason_code|vendor|.*(?:_at|_id|cursor|fingerprint|hash))$',k,re.I) and len(v)<120 and re.fullmatch(r'[A-Za-z0-9_.:+\-/TZ ]*',v):x[k]=v
 return x
for d in [r/'state',r/'scripts'/'state']:
 if not d.exists():continue
 for p in d.glob('*inventory*'):
  if not p.is_file() or re.search(r'secret|token|auth|credential',p.name,re.I):continue
  st=p.stat();raw=p.read_bytes();x={'path':str(p),'bytes':len(raw),'mtime_ns':st.st_mtime_ns,'sha256':hashlib.sha256(raw).hexdigest()}
  if p.suffix in ['.jsonl','.json']:
   records=[]
   if p.suffix=='.json':
    try:records=[json.loads(raw)]
    except ValueError:pass
   else:
    for line in raw.splitlines()[-5:]:
     try:records.append(json.loads(line))
     except ValueError:pass
   x['recent_safe_metadata']=[safe(v) for v in records];x['latest_schema_keys']=list(records[-1]) if records and isinstance(records[-1],dict) else []
  out['files'].append(x)
p=r/'cron'/'jobs.json';doc=json.loads(p.read_text(encoding='utf8'));jobs=doc.get('jobs',[]) if isinstance(doc,dict) else doc
j=next(j for j in jobs if j['id']=='d68cb0c1ae05');out['job_workdir']=j.get('workdir')
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Router state capture failed'}
