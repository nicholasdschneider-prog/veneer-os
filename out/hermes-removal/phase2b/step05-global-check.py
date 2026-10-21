from pathlib import Path
import sqlite3,json,datetime,hashlib
b=Path(r'C:\Users\nicho\AppData\Local\hermes');rows=[]
for p in [b/'cron/executions.db',*b.glob('profiles/*/cron/executions.db')]:
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
 try:n=c.execute("select count(*) from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchone()[0]
 finally:c.close()
 rows.append({'path':str(p),'unfinished':n})
a=Path(r'C:\Users\nicho\backups\hermes-final-20261016');r=a/'quiescent-20261021';old=a/'reconcile-20261016/verification.json'
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ledgers':rows,'all_unfinished':sum(x['unfinished'] for x in rows),'seal_directory_exists':r.exists(),'old_baseline_state':json.loads(old.read_text())['state'],'old_manifest_sha256':json.loads(old.read_text())['original_manifest_sha256'],'source_roots':[{ 'path':str(p),'exists':p.exists()} for p in [b,Path(r'C:\Users\nicho\.hermes'),Path(r'C:\Users\nicho\HermesBrainOps'),Path(r'C:\Users\nicho\HermesLegacyData'),Path(r'C:\Users\nicho\ObsidianVaults\Hermes Brain'),Path(r'C:\Users\nicho\.worktrees')]]}))
