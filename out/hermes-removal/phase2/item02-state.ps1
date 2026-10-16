$py=@'
import pathlib,json,hashlib,datetime as dt
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');b=r/'profiles'/'cs-tim';out={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'profile':'cs-tim','watcher_state':[]}
for name,keys in [('reply-monitor-SP6NF4.json',['seen']),('brady-sms-reply-monitor-state.json',['notifiedInboundIds'])]:
 p=b/'runtime'/name;d={'path':str(p),'exists':p.exists()}
 if p.exists():
  raw=p.read_bytes();j=json.loads(raw);d.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),mtime_ns=p.stat().st_mtime_ns,counts={k:len(j.get(k,[])) for k in keys})
  d['ids']={k:[x for x in j.get(k,[]) if isinstance(x,(str,int)) and (isinstance(x,int) or all(c.isalnum() or c in '-_:' for c in x))] for k in keys}
 out['watcher_state'].append(d)
p=b/'gateway_state.json'
if p.exists():
 j=json.loads(p.read_text(encoding='utf8'));out['gateway_status']={k:j.get(k) for k in ['pid','state','active_agents','updated_at','started_at','start_time']}
p=r/'profiles'/'ervp-orders'/'state'/'orders-bot'/'every-order-review.json'
if p.exists():
 raw=p.read_bytes();j=json.loads(raw);out['completion_shared_ledger']={'path':str(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'order_count':len(j.get('orders',{})),**{k:j.get(k) for k in ['updated_at','last_success_at','last_daily_closure_date']},'note':'Held All Order Review remains the writer. Mirror consumer disabled; file preserved.'}
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'State metadata failed'}
