from pathlib import Path
import ast,json,re,sqlite3,datetime,hashlib
repo=Path(r'C:\Users\nicho\ervp-vendor-automation');root=Path(r'C:\Users\nicho\AppData\Local\hermes');state=root/'profiles/ervp-orders/state/orders-bot'
source=[]
for p in [repo/'owner_policy_orchestration.py',repo/'production_owner_policy_cycle.py',repo/'vendor_communications.py',root/'profiles/ervp-orders/scripts/orders_bot_worker.py']:
 tree=ast.parse(p.read_text(encoding='utf-8-sig'));r={'path':str(p),'lock_functions':[],'file_assignments':[]}
 for n in ast.walk(tree):
  if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and (re.fullmatch(r'(?:acquire|release|.*lock.*|.*scheduler.*|run_scheduled)',n.name) or (p.name=='owner_policy_orchestration.py' and any(isinstance(v,ast.Attribute) and v.attr in ['mkdir','rmdir','unlink','lock'] for v in ast.walk(n)))):
   # Never export a function that handles credentials or arbitrary business payload.
   text=ast.unparse(n)
   r['lock_functions'].append({'signature':ast.unparse(n.args),'name':n.name,'line':n.lineno,'body_sha256':hashlib.sha256(text.encode()).hexdigest(),'lock_statements':[ast.unparse(v) for v in ast.walk(n) if isinstance(v,(ast.Assign,ast.Expr)) and len(ast.unparse(v))<350 and re.search(r'mkdir|rmdir|\.lock|owner\.json|os\.open|O_EXCL|self\.lock|OWNER_DIR|STATE_LOCK_DIR',ast.unparse(v)) and not re.search(r'auth|secret|token|cookie|credential',ast.unparse(v),re.I)]})
  if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and v.id in ['DEFAULT_DB_PATH','PROFILE','LOCK_PATH'] for v in n.targets):r['file_assignments'].append(ast.unparse(n))
 source.append(r)
files=[]
paths=[state/'owner-policy-candidates.json',state/'owner-policy-last-scan.json',state/'commands.json',repo/'state/vendor-order-runs.json',repo/'memory/dometic-pending-verification.json']
for d in [state/'owner-policy-lane',state/'owner.lock',state/'command-state.lock']:
 if d.is_dir():paths.extend(p for p in d.iterdir() if p.is_file())
for p in paths:
 r={'path':str(p),'exists':p.is_file()}
 if p.is_file():
  data=p.read_bytes();r.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),mtime_ns=p.stat().st_mtime_ns)
  if p.suffix=='.json':
   d=json.loads(data.decode('utf-8-sig'));r['shape']={'type':type(d).__name__,'top_keys':list(d) if isinstance(d,dict) else None,'rows':len(d) if isinstance(d,list) else None};r['fields']={k:{'type':type(v).__name__,'count':len(v) if isinstance(v,(dict,list)) else None,'sha256':hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest()} for k,v in d.items()} if isinstance(d,dict) else None
 files.append(r)
p=repo/'state/vendor-governance.sqlite3';db={'path':str(p),'exists':p.is_file()}
if p.is_file():
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
 try:
  db['tables']=[]
  for name, in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
   q='"'+name.replace('"','""')+'"';db['tables'].append({'name':name,'columns':[r[1] for r in c.execute('pragma table_info('+q+')')],'count':c.execute('select count(*) from '+q).fetchone()[0]})
 finally:c.close()
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':source,'state_schema':files,'governance_db':db,'scope':'read-only preliminary schema, NOT final drained custody','no_job_invoked':True}))
