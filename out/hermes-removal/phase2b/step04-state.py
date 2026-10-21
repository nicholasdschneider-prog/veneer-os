from pathlib import Path
import json,hashlib,datetime,re,ast
root=Path(r'C:\Users\nicho\AppData\Local\hermes');base=root/'profiles/hermesops';d=json.loads((base/'cron/jobs.json').read_text(encoding='utf-8-sig'));jobs=d.get('jobs',[]) if isinstance(d,dict) else d;j=next(v for v in jobs if v['id']=='48352e1e4b39');names=sorted(set(re.findall(r'[\w.-]+\.(?:py|ps1|cmd|vbs)',json.dumps(j))))
queue=[(root/'services/Hermes_Brain_Backup-silent.vbs',0)]
for name in names:
 for b in [base/'scripts',root/'scripts',Path(r'C:\Users\nicho\.hermes\scripts'),Path(r'C:\Users\nicho\HermesBrainOps')]:
  if (b/name).is_file():queue.append((b/name,0))
files=[];sources=[];seen=set()
def meta(p):
 if not p.is_file() or re.search(r'auth|secret|token|credential|cookie|config|settings|\.env',p.name,re.I):return
 raw=p.read_bytes();r={'path':str(p),'bytes':len(raw),'mtime_ns':p.stat().st_mtime_ns,'sha256':hashlib.sha256(raw).hexdigest()}
 if p.suffix=='.json' and len(raw)<5_000_000:
  try:
   v=json.loads(raw.decode('utf-8-sig'));r['field_hashes']={k:hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest() for k,x in v.items()} if isinstance(v,dict) else None
  except ValueError:r['json_invalid']=True
 files.append(r)
while queue and len(seen)<20:
 p,depth=queue.pop(0)
 if str(p) in seen or not p.is_file():continue
 seen.add(str(p));meta(p);s=p.read_text(encoding='utf-8-sig',errors='replace');paths=sorted(set(re.findall(r'[A-Za-z]:[\\/][^"\r\n]*?\.(?:py|ps1|cmd|vbs|json|jsonl|lock)',s)))
 paths=[v for v in paths if not re.search(r'auth|secret|token|credential|cookie|config|\.env',v,re.I)];r={'path':str(p),'file_paths':paths,'state_names':sorted(set(re.findall(r'[\w.-]+\.(?:json|jsonl|sqlite3|db|lock)',s)))}
 if p.suffix=='.py':
  tree=ast.parse(s);r['calls']=sorted(set(ast.unparse(n.func) for n in ast.walk(tree) if isinstance(n,ast.Call)));r['path_assignments']=[ast.unparse(n) for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and re.fullmatch(r'[A-Z_]*(?:STATE|ROOT|PATH|DIR|HOME)',v.id) for v in n.targets) and len(ast.unparse(n))<250 and not re.search(r'auth|secret|token|credential|cookie|config|environ',ast.unparse(n),re.I)]
 sources.append(r)
 if depth<3:
  for v in paths:
   target=Path(v)
   if target.suffix.lower() in ['.py','.ps1','.cmd','.vbs']:queue.append((target,depth+1))
   elif target.is_file():meta(target)
if (base/'state').is_dir():
 for p in (base/'state').iterdir():
  if p.is_file():meta(p)
vault=Path(r'C:\Users\nicho\ObsidianVaults\Hermes Brain');extra=[vault/'Backup Status.json',vault/'Generated/Backup Manifest.json',vault/'Generated/Hermes/Hermes Export Manifest.json'];absent=[]
for p in extra:
 if p.is_file():meta(p)
 else:absent.append(str(p))
log=root/'backup-logs/brain-vault'
if log.is_dir():
 for p in sorted(log.iterdir(),key=lambda p:p.stat().st_mtime_ns,reverse=True)[:5]:
  if p.is_file():meta(p)
print(json.dumps({'absent_exact_paths':absent,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'job_script_names':names,'sources':sources,'files':files,'no_job_invoked':True,'contents_stay_pc':True,'scope':'bounded exact launch chain max20 depth3 plus hermesops top-level state'}))
