"""Narrow cron disable/readback under the scheduler's Windows .jobs.lock; no Hermes import."""
import pathlib,json,os,sys,msvcrt,hashlib,datetime as dt,time,sqlite3
root=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes')
profile,job_id,mode=sys.argv[1:]
p=(root if profile=='root' else root/'profiles'/profile)/'cron'/'jobs.json'
lock=p.parent/'.jobs.lock'
def stamp():return dt.datetime.now(dt.timezone.utc).isoformat()
def metadata(j):
 return {k:j.get(k) for k in ['id','name','enabled','state','schedule','last_run_at','next_run_at','last_status','failure_streak']}
def ledger():
 db=p.parent/'executions.db'
 if not db.exists():return {'exists':False}
 c=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=5)
 try:
  cols={v[1] for v in c.execute('pragma table_info(executions)')}
  keys=[v for v in ['id','job_id','pid','process_id','process_started_at','status','claimed_at','started_at','finished_at'] if v in cols]
  if 'job_id' not in cols:return {'exists':True,'error':'unrecognized schema'}
  rows=[dict(zip(keys,r)) for r in c.execute('select '+','.join(keys)+' from executions where job_id=? order by rowid desc limit 8',(job_id,))]
  active=[dict(zip(keys,r)) for r in c.execute('select '+','.join(keys)+" from executions where job_id=? and finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')",(job_id,))]
  count=c.execute('select count(*) from executions where job_id=?',(job_id,)).fetchone()[0]
  all_unfinished=c.execute("select count(*) from executions where finished_at is null and status not in ('completed','failed','interrupted','cancelled','skipped','duplicate','abandoned')").fetchone()[0]
  return {'exists':True,'recent':rows,'unfinished_all_profile':all_unfinished,'unfinished':len(active),'active':active,'total_executions':count}
 finally:c.close()
with lock.open('a+b') as f:
 deadline=time.monotonic()+10
 while True:
  try:f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1);break
  except OSError:
   if time.monotonic()>deadline:raise RuntimeError('Scheduler ownership unavailable; no mutation')
   time.sleep(.1)
 try:
  raw=p.read_bytes();doc=json.loads(raw.decode('utf-8-sig'));jobs=doc.get('jobs',[]) if isinstance(doc,dict) else doc
  selected=[j for j in jobs if j.get('id')==job_id]
  if len(selected)!=1 or type(selected[0].get('enabled')) is not bool:raise RuntimeError('Ambiguous job or invalid enabled state')
  j=selected[0];before=metadata(j);preledger=ledger();before_hash=hashlib.sha256(raw).hexdigest()
  if mode=='disable':
   if preledger.get('unfinished',0) or preledger.get('unfinished_all_profile',0) or preledger.get('error') or not preledger.get('exists'):raise RuntimeError('In-flight or unreadable ledger; no mutation')
   if j['enabled'] is not True:raise RuntimeError('Already disabled: inspect existing receipt before any mutation')
   backup=pathlib.Path(r'C:\Users\nicho\backups\hermes-phase2b-20261021')/profile
   backup.mkdir(parents=True,exist_ok=True)
   with (backup/(job_id+'-jobs-before.json')).open('xb') as b:b.write(raw)
   j['enabled']=False
   encoded=(json.dumps(doc,ensure_ascii=False,indent=2)+'\n').encode('utf8')
   candidate=json.loads(encoded)
   cmp=json.loads(raw.decode('utf-8-sig'));cj=cmp.get('jobs',[]) if isinstance(cmp,dict) else cmp
   next(v for v in cj if v.get('id')==job_id)['enabled']=False
   if cmp!=candidate:raise RuntimeError('Unrelated semantic change')
   # Hold the scheduler's lock throughout edit and readback.
   with p.open('r+b') as dst:dst.write(encoded);dst.truncate();dst.flush();os.fsync(dst.fileno())
   check=json.loads(p.read_text(encoding='utf-8-sig'))
   if check!=candidate:raise RuntimeError('Readback mismatch; inspect before retry')
  else:check=doc
  checkjobs=check.get('jobs',[]) if isinstance(check,dict) else check
  after=metadata(next(v for v in checkjobs if v.get('id')==job_id))
  print(json.dumps({'at':stamp(),'profile':profile,'id':job_id,'operation':mode,'file':str(p),'before':before,'after':after,'before_sha256':before_hash,'after_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'ledger':preledger,'no_job_invoked':True,'scheduler_lock':'msvcrt byte 0 .jobs.lock acquired'}))
 finally:f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
