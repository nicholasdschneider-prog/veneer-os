"""Bounded read-only metadata of selected job sources and local retained state. Never imports Hermes."""
from pathlib import Path
import json,hashlib,datetime,re,ast,sqlite3
root=Path(r'C:\Users\nicho\AppData\Local\hermes')
groups={'ervp-orders':['ce09b813238c','b95f03d799dc'],'root':['9b03a939ef99'],'ervp-dev2':['9868ee5f2643']}
files={};sources=[];refs=[];absent=[]
def safe(p):return not re.search(r'auth|secret|token|credential|cookie|config|settings|\.env',p.name,re.I)
def meta(p):
 if not p.is_file() or not safe(p):return
 st=p.stat();r={'path':str(p),'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 if p.suffix=='.json' and st.st_size<8_000_000:
  try:
   d=json.loads(p.read_text(encoding='utf-8-sig'))
   if isinstance(d,dict):r['field_hashes']={k:hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest() for k,v in d.items()}
  except Exception as e:r['parse_error']=type(e).__name__
 if p.suffix in ['.sqlite3','.db','.sqlite']:
  c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=3)
  try:r['tables']={n:c.execute('SELECT count(*) FROM "'+n.replace('"','""')+'"').fetchone()[0] for n, in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")}
  finally:c.close()
 files[str(p)]=r
for profile,ids in groups.items():
 b=root if profile=='root' else root/'profiles'/profile
 d=json.loads((b/'cron/jobs.json').read_text(encoding='utf-8-sig'));jobs=d.get('jobs',[]) if isinstance(d,dict) else d
 for j in jobs:
  if j['id'] not in ids:continue
  # Extract only script filenames, never job text or command arguments.
  names=sorted(set(re.findall(r'[\w.-]+\.py',json.dumps(j))))
  refs.append({'profile':profile,'id':j['id'],'script_names':names})
  for n in names:
   candidates=[b/'scripts'/n,Path(r'C:\Users\nicho\.hermes\scripts')/n,Path(r'C:\Users\nicho\ervp-vendor-automation')/n]
   for p in candidates:
    if not p.is_file():continue
    meta(p);s=p.read_text(encoding='utf-8-sig');tree=ast.parse(s)
    sources.append({'path':str(p),'referenced_scripts':sorted(set(re.findall(r'[\w.-]+\.py',s))),'state_filenames':sorted(set(re.findall(r'[\w.-]+\.(?:json|jsonl|sqlite3|sqlite|db|lock)',s))),'locking_mentions':sorted(set(re.findall(r'\b(?:msvcrt|flock|FileLock|locking|lock_path)\b',s)))})
 for area in ['state']:
  if (b/area).is_dir():
   for p in (b/area).iterdir():
    if p.is_file():meta(p)
# Known shadow output locations from previously reviewed source; no consumer-absence assertion.
b=root/'profiles/ervp-dev2/workspace/lippert-final-tracking-owner'
for d in ['state','reports']:
 if (b/d).is_dir():
  for p in (b/d).iterdir():
   if p.is_file():meta(p)
# Exact paths found in job definitions and static source; capture both historical homes when relative.
for base in [root,root/'profiles/ervp-orders',Path(r'C:\Users\nicho\.hermes')]:
 for rel in ['state/orders-bot/commands.json','state/vendor-order-runs.json','state/orders-bot/vendor-failure-watchdog-state.json']:
  p=base/rel
  if p.exists():meta(p)
  else:absent.append(str(p))
p=Path(r'C:\Users\nicho\ltl-tracking-cleanup.py')
if p.exists():
 meta(p);tree=ast.parse(p.read_text(encoding='utf-8-sig'));sources.append({'path':str(p),'state_filenames':sorted(set(re.findall(r'[\w.-]+\.(?:json|jsonl|sqlite3|sqlite|db|lock)',p.read_text(encoding='utf-8-sig'))))})
else:absent.append(str(p))
print(json.dumps({'absent_exact_paths':absent,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'references':refs,'sources':sources,'files':list(files.values()),'contents_stay_pc':True,'no_job_invoked':True,'scope_limit':'bounded top-level profile state and known Lippert workspace; remote business state not queried'}))
