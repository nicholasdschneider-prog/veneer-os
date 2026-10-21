"""Bounded static path/lock audit. Reads source, never imports or executes it."""
from pathlib import Path
import ast,re,json,hashlib,datetime
root=Path(r'C:\Users\nicho\AppData\Local\hermes');repo=Path(r'C:\Users\nicho\ervp-vendor-automation');scripts=root/'profiles/ervp-orders/scripts'
queue=[(repo/'production_owner_policy_cycle.py',0),(scripts/'run_production_owner_policy_cycle.cmd',0),(root/'services/ERVP_Orders_Bot_Direct_Shopify-silent.vbs',0),(root/'services/ERVP_Orders_Bot_All_Order_Review-silent.vbs',0),(scripts/'run_every_order_review.cmd',0)];seen=set();out=[]
while queue and len(seen)<30:
 p,depth=queue.pop(0)
 if str(p) in seen:continue
 seen.add(str(p));r={'path':str(p),'exists':p.is_file()}
 if not p.is_file():out.append(r);continue
 data=p.read_bytes();s=data.decode('utf-8-sig',errors='replace');r['sha256']=hashlib.sha256(data).hexdigest();r['bytes']=len(data)
 r['script_names']=sorted(set(re.findall(r'[\w.-]+\.(?:py|cmd|vbs)',s)))
 r['state_names']=sorted(set(re.findall(r'[\w.-]+\.(?:json|jsonl|sqlite3|sqlite|db|lock)',s)))
 r['locking_terms']=sorted(set(re.findall(r'\b(?:msvcrt|flock|FileLock|LK_NBLCK|LK_LOCK|locking|lock_path|acquire_lock|release_lock|singleton_lock)\b',s)))
 if p.suffix=='.py':
  t=ast.parse(s);r['imports']=[ast.unparse(n) for n in ast.walk(t) if isinstance(n,(ast.Import,ast.ImportFrom))]
  r['calls']=sorted(set(ast.unparse(n.func) for n in ast.walk(t) if isinstance(n,ast.Call)))
  r['file_path_literals']=[n.value for n in ast.walk(t) if isinstance(n,ast.Constant) and isinstance(n.value,str) and len(n.value)<250 and re.fullmatch(r'[\w .:/\\-]+\.(?:py|cmd|vbs|json|jsonl|sqlite3|sqlite|db|lock)',n.value) and not re.search(r'auth|cookie|credential|secret|token|config',n.value,re.I)]
  r['path_assignments']=[ast.unparse(n) for n in ast.walk(t) if isinstance(n,(ast.Assign,ast.AnnAssign)) and any(re.fullmatch(r'[A-Z_]*(?:ROOT|PATH|STATE|LOCK|DIR|HOME)',v.id) for v in ast.walk(n) if isinstance(v,ast.Name)) and len(ast.unparse(n))<300 and not re.search(r'auth|cookie|credential|secret|token|config|environ',ast.unparse(n),re.I)]
 if p.suffix=='.py' and depth<2:
  for node in ast.walk(t):
   if isinstance(node,ast.ImportFrom) and node.module:
    relative=node.module.replace('.', '/')+'.py'
    for base in [repo,repo/'src']:
     target=base/relative
     if target.is_file():queue.append((target,depth+1));break
 if depth<2:
  for n in r['script_names']:
   for base in [p.parent,repo,scripts,root/'services']:
    if (base/n).is_file():queue.append((base/n,depth+1));break
 out.append(r)
# Only immediate entries in explicit directories; filenames/sizes, no customer data.
listing=[]
for d in [scripts.parent/'state',scripts.parent/'state/orders-bot',repo/'state']:
 if d.is_dir():
  listing.append({'directory':str(d),'entries':[{'name':p.name,'is_dir':p.is_dir(),'bytes':p.stat().st_size if p.is_file() else None} for p in d.iterdir() if not re.search(r'auth|secret|token|credential|cookie|config|settings|\.env',p.name,re.I)]})
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':out,'bounded_state_listing':listing,'no_job_invoked':True,'limit':'max30 exact referenced scripts, depth2; no broad source traversal'}))
