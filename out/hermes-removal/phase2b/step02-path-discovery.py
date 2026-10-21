from pathlib import Path
import ast,json,re
root=Path(r'C:\Users\nicho\AppData\Local\hermes'); paths=[root/'profiles/ervp-orders/scripts/vendor_failure_watchdog.py',root/'profiles/ervp-orders/scripts/ltl_tracking_cleanup.py']
# Bounded immediate script directories to locate the root job's hyphenated helper.
for base in [root/'scripts',Path(r'C:\Users\nicho\.hermes\scripts'),Path(r'C:\Users\nicho\ervp-vendor-automation')]:
 if base.is_dir():paths.extend(p for p in base.iterdir() if p.name=='ltl-tracking-cleanup.py')
out=[]
for p in paths:
 t=ast.parse(p.read_text(encoding='utf-8-sig'));out.append({'path':str(p),'path_literals':[n.value for n in ast.walk(t) if isinstance(n,ast.Constant) and isinstance(n.value,str) and len(n.value)<240 and re.fullmatch(r'[\w .:/\\-]+\.(?:py|json|jsonl|lock|sqlite3|db)',n.value) and not re.search(r'auth|secret|token|credential|cookie|config',n.value,re.I)],'path_assignments':[ast.unparse(n) for n in ast.walk(t) if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and re.fullmatch(r'(?:[A-Z_]*ROOT|STATE|STATE_PATH|RUNS_PATH|WORKSPACE|LOCK_PATH|BASE|HERMES_HOME)',v.id) for v in n.targets) and 'environ' not in ast.unparse(n)]})
d=json.loads((root/'cron/jobs.json').read_text(encoding='utf-8-sig'));jobs=d.get('jobs',[]) if isinstance(d,dict) else d
for j in jobs:
 if j['id']=='9b03a939ef99':
  text=json.dumps(j).replace('\\\\','\\');out.append({'root_job_script_paths':re.findall(r'[A-Za-z]:[\\/][\w .:/\\-]+?\.py',text)})
print(json.dumps(out))
