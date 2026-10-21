"""Read-only source snapshot after task drain; writes new PC custody only, exports sanitized metadata."""
from pathlib import Path
import json,hashlib,datetime,sqlite3,shutil
repo=Path(r'C:\Users\nicho\ervp-vendor-automation');state=Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-orders\state\orders-bot');dest=Path(r'C:\Users\nicho\backups\hermes-phase2b-20261021\step03\final-custody')
if dest.exists():raise RuntimeError('Custody exists: inspect source receipt, do not overwrite/repeat')
# Read source schemas without business imports; final snapshot no source mutation.
files=[state/'owner-policy-candidates.json',state/'owner-policy-last-scan.json',state/'commands.json',repo/'state/vendor-order-runs.json',repo/'memory/dometic-pending-verification.json']
for folder in [state/'owner-policy-lane']:
 if folder.is_dir():files.extend(p for p in folder.iterdir() if p.is_file() and p.suffix=='.json')
# Preserve order-review checkpoint/ledger files discovered by bounded immediate listing.
for p in state.iterdir():
 if p.is_file() and p.suffix in ['.json','.jsonl'] and any(t in p.name.lower() for t in ['checkpoint','ledger','every-order','all-order','order-review']):files.append(p)
def fingerprint(v):return hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest()
allowed={'id','order_number','order_name','order_id','command_id','vendor','status','state','confirmation_number','confirmation_id','po_number','purchase_order','created_at','updated_at','next_check_at','active_pending_count'}
def project(v):
 if not isinstance(v,dict):return {'row_sha256':fingerprint(v)}
 return {k:x for k,x in v.items() if k in allowed and (x is None or isinstance(x,(str,int,float,bool)))}|{'row_sha256':fingerprint(v),'field_names':sorted(v)}
def rows(v):
 if isinstance(v,list):return [project(x) for x in v]
 if isinstance(v,dict):return [{'key':k,**project(x)} for k,x in v.items()]
 return None
dest.mkdir(parents=True)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pc_custody':str(dest),'no_job_invoked':True,'files':[],'sanitized':{},'limitations':[]}
for i,p in enumerate(dict.fromkeys(files)):
 r={'path':str(p),'exists':p.is_file()}
 if p.is_file():
  raw=p.read_bytes();st=p.stat();r.update(bytes=len(raw),mtime_ns=st.st_mtime_ns,sha256=hashlib.sha256(raw).hexdigest());target=dest/(str(i)+'-'+p.name);target.write_bytes(raw);r['custody_path']=str(target)
  if p.suffix=='.json':
   d=json.loads(raw.decode('utf-8-sig'));r['field_hashes']={k:fingerprint(v) for k,v in d.items()} if isinstance(d,dict) else None
   if p.name=='owner-policy-candidates.json':out['sanitized']['candidates']=rows(d.get('candidates',[]))
   elif p.name=='commands.json':out['sanitized']['commands']=rows(d.get('commands',[]))
   elif p.name=='vendor-order-runs.json':out['sanitized']['vendor_order_runs']={k:rows(d.get(k)) for k in ['orders','runs']};out['limitations'].append('Vendor order rows preserved with statuses; pending classification must use each row status, no inference from container count.')
   elif p.name=='dometic-pending-verification.json':out['sanitized']['dometic_pending']={k:(rows(v) if isinstance(v,(dict,list)) else v) for k,v in d.items() if k in ['pending','active_pending_count','active_pending_pos','updated_at','next_check_at']}
   elif p.name=='owner-policy-lane.json':out['sanitized']['owner_policy_lane']={k:rows(v) for k,v in d.items() if k in ['groups','processed_slots']}
  if p.stat().st_mtime_ns!=st.st_mtime_ns or hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256']:raise RuntimeError('Source changed during custody; retain attempt and reconcile before retry')
 out['files'].append(r)
p=repo/'state/vendor-governance.sqlite3';snapshot=dest/'vendor-governance.sqlite3';src=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5);dst=sqlite3.connect(snapshot)
try:src.backup(dst)
finally:dst.close();src.close()
c=sqlite3.connect(snapshot.as_uri()+'?mode=ro',uri=True)
try:
 out['governance_snapshot']={'path':str(snapshot),'sha256':hashlib.sha256(snapshot.read_bytes()).hexdigest(),'integrity_check':[r[0] for r in c.execute('pragma integrity_check')],'tables':{}}
 for name in ['governance_outbox','governance_workflows','lippert_notification_workflows']:
  cols=[r[1] for r in c.execute('pragma table_info('+name+')')];keys=[k for k in cols if k in allowed or k in ['aggregate_id','aggregate_type','adapter','topic','claimed_at','delivered_at','receipt_id']]
  out['governance_snapshot']['tables'][name]={'total':c.execute('select count(*) from '+name).fetchone()[0],'safe_rows':[dict(zip(keys,r)) for r in c.execute('select '+','.join(keys)+' from '+name)]}
  if 'status' in cols:out['governance_snapshot']['tables'][name]['status_counts']={s:n for s,n in c.execute('select status,count(*) from '+name+' group by status')}
finally:c.close()
# Full JSON bodies and SQLite payload remain in the PC custody directory. Export only safe projections.
(dest/'sanitized-delta.json').write_text(json.dumps(out,indent=2)+'\n',encoding='utf-8')
print(json.dumps(out))
