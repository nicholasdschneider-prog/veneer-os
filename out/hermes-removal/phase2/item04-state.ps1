$py=@'
import pathlib,json,hashlib,re,datetime as dt
b=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-orders\state');out={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'files':[]}
paths=['vendor-email-watch-100118388.json','technical-incidents/dometic-reply-watcher-101592515.json','manual-dometic-watch-100120323-100120506.json']
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def projection(k,v):
 o={'type':type(v).__name__,'value_sha256':digest(v)}
 if isinstance(v,(list,dict)):o['count']=len(v)
 if re.search(r'cursor|reported_message_ids|notified.*ids|last.*(?:_id|_at|time)|checked_at|fingerprint|status|ok',k,re.I):
  if isinstance(v,(bool,int,float)) or v is None:o['value']=v
  elif isinstance(v,str) and len(v)<=128 and re.fullmatch(r'[A-Za-z0-9_:+.TZ/\-]*',v):o['value']=v
  elif isinstance(v,list) and all(isinstance(x,str) and len(x)<128 and re.fullmatch(r'[A-Za-z0-9_:\-]+',x) for x in v):o['ids']=v
 return o
for rel in paths:
 p=b/rel;d={'path':str(p),'exists':p.exists()}
 if p.exists():
  raw=p.read_bytes();j=json.loads(raw);st=p.stat();d.update(bytes=len(raw),mtime_ns=st.st_mtime_ns,sha256=hashlib.sha256(raw).hexdigest())
  if isinstance(j,dict):d['fields']={k:projection(k,v) for k,v in j.items() if not re.search('token|credential|secret|password|auth',k,re.I)}
 out['files'].append(d)
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Dometic state capture failed'}
