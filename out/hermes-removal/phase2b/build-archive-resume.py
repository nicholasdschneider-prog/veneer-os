"""Generate the isolated reviewed resume controller; no application source edits."""
from pathlib import Path
p=Path(__file__).parent;s=(p/'archive-quiescent.py').read_text()
s=s.replace("R=B/'quiescent-20261021'","R=B/'quiescent-resume-20261021';OLD=B/'quiescent-20261021'")
s=s.replace('import pathlib,os,json,hashlib,sqlite3,datetime,time,shutil,subprocess,fnmatch','import pathlib,os,json,hashlib,sqlite3,datetime,time,shutil,subprocess,fnmatch,ctypes,traceback')
a=s.index('def sqlcheck(');b=s.index('def header(',a)
s=s[:a]+'''def sqlite_path(p,immutable=True):
 normal=pathlib.Path(str(p)[len(PREFIX):] if str(p).startswith(PREFIX) else str(p))
 buf=ctypes.create_unicode_buffer(32768);n=ctypes.windll.kernel32.GetShortPathNameW(ext(normal),buf,len(buf))
 if n and n<len(buf):
  alias=buf.value
  if not os.path.samefile(alias,ext(normal)):raise RuntimeError('SQLite short-path identity mismatch')
  candidate=pathlib.Path(alias[len(PREFIX):] if alias.startswith(PREFIX) else alias)
  if len(str(candidate))<220:
   with (R/'sqlite-access.jsonl').open('a') as f:f.write(json.dumps({'source':str(normal),'method':'verified_8dot3','identity_matches':True,'alias_chars':len(str(candidate))})+'\\n')
   return candidate
 if len(str(normal))<220:
  if not os.path.isfile(ext(normal)):raise RuntimeError('SQLite input missing')
  return normal
 # Built-in SQLite may reject even an extended-length URI. Copy through extended
 # Windows file handles into an isolated short custody path, proving bytes first.
 st=os.stat(ext(normal));key=hashlib.sha256((str(normal)+str(st.st_size)+str(st.st_mtime_ns)+str(immutable)).encode()).hexdigest()
 target=R/'sql-short'/(key+'.db')
 if len(str(target))>=220:raise RuntimeError('Short SQLite custody path exceeds bound')
 if not os.path.isfile(ext(target)):copy_new(normal,target)
 h=sha(normal)
 if sha(target)!=h:raise RuntimeError('Extended-handle SQLite custody hash mismatch')
 if not immutable:
  for suffix in ['-wal','-shm']:
   src=pathlib.Path(str(normal)+suffix);dst=pathlib.Path(str(target)+suffix)
   if os.path.isfile(ext(src)):
    if not os.path.isfile(ext(dst)):copy_new(src,dst)
    if sha(src)!=sha(dst):raise RuntimeError('Source sidecar custody hash mismatch')
 with (R/'sqlite-access.jsonl').open('a') as f:f.write(json.dumps({'source':str(normal),'method':'verified_extended_handle_copy','custody':str(target),'sha256':h})+'\\n')
 return target

def sqlopen(p,readonly=True,immutable=True):
 safe=sqlite_path(p,immutable)
 return sqlite3.connect(safe.as_uri()+('?mode=ro'+('&immutable=1' if immutable else '') if readonly else '?mode=rw'),uri=True,timeout=10)

def sqlcheck(p):
 c=sqlopen(p);deadline=time.monotonic()+300
 c.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
 try:return [r[0] for r in c.execute('pragma integrity_check')]==['ok']
 finally:c.close()
''' +s[b:]
s=s.replace('archive-quiescent\\\\.py','archive-quiescent(?:-resume)?\\\\.py')
a=s.index(' if R.exists():raise RuntimeError');b=s.index(" guards=[guard()]",a)
s=s[:a]+''' reconciliation=json.loads((R/'reconciliation.json').read_text())
 if reconciliation['state']!='reconciled_ready' or reconciliation['unresolved']:raise RuntimeError('Reconciliation prerequisite failed')
 if (R/'status.json').exists():raise RuntimeError('Resume status exists: reconcile before any replay')
 status('resume_starting');scope=json.loads((B/'scope.json').read_text());old=json.loads((B/'reconcile-20261016/verification.json').read_text());assert old['state']=='verified_reconciled_baseline'
''' +s[b:]
a=s.index(" db=sqlite3.connect(R/'operator-index.sqlite3');db.execute('create table baseline")
b=s.index(' n=0;versions=',a)
s=s[:a]+''' db=sqlite3.connect(R/'operator-index.sqlite3')
 assert db.execute('select count(*) from source').fetchone()[0]==reconciliation['reconciled_rows']
 db.execute('update source set seen=0');db.commit()
''' +s[b:]
s=s.replace("n=0;versions=0;sqlites=0;errors=[];roots=[];changed=set()","n=0;versions=reconciliation['prior_version_count'];sqlites=0;errors=[];roots=[];changed={r[0] for r in db.execute('select s.path from source s left join baseline b on b.path=s.path where b.sha is null or b.sha!=s.expected_sha')}")
s=s.replace("  for source,label in zip(sources,labels):", "  with (OLD/'versions.jsonl').open() as existing_versions:\n   for line in existing_versions:ver.write(line)\n  for source,label in zip(sources,labels):",1)
a=s.index("     st=p.stat();isdb=header(p)==")
s=s[:a]+'''     previous=db.execute('select source_path,size,mtime,expected_sha,is_sqlite,snapshot from source where path=?',(key,)).fetchone()
     if previous:
      st=p.stat()
      if st.st_size!=previous[1] or st.st_mtime_ns!=previous[2]:raise RuntimeError('Reconciled source metadata changed; stop')
      record={'path':key,'source':previous[0],'bytes':previous[1],'mtime_ns':previous[2],'sha256':previous[3],'sqlite':bool(previous[4]),'snapshot':str(pathlib.Path(previous[5]).relative_to(B)) if previous[5] else None,'reused_reconciled_capture':True};inv.write(json.dumps(record)+'\\n')
      n+=1;sqlites+=int(previous[4])
      if n%10000==0:status('resume_reusing_or_hashing_source',files=n,sqlite_found=sqlites,previous_versions=versions,reconciled_source_rows=reconciliation['reconciled_rows'])
      continue
''' +s[a:]
s=s.replace("snapshot=R/'sqlite-current'/label/rel;os.makedirs(ext(snapshot.parent),exist_ok=True)\n      sc=sqlite3.connect(pathlib.Path(str(p)).as_uri()+'?mode=ro',uri=True,timeout=10);dc=sqlite3.connect(ext(snapshot));deadline=time.monotonic()+300", "snapshot=R/'sqlite-current-flat'/(hashlib.sha256(key.encode()).hexdigest()+'.sqlite3');os.makedirs(ext(snapshot.parent),exist_ok=True)\n      with open(ext(snapshot),'xb'):pass\n      sc=sqlopen(p,immutable=False);dc=sqlopen(snapshot,readonly=False);deadline=time.monotonic()+300")
s=s.replace("'nonstandard_extension':p.suffix.lower() not in ['.db','.sqlite','.sqlite3']", "'nonstandard_extension':p.suffix.lower() not in ['.db','.sqlite','.sqlite3'],'kind':'mirror'")
a=s.index(' restores=[]')
s=s[:a]+''' # Validate all new/reused historical and snapshot SQLite copies, regardless extension.
 supplemental=0;db.close()
 for area in [OLD/'sqlite-current',OLD/'previous-payload',R/'sqlite-current-flat',R/'previous-payload',R/'sql-short']:
  if not area.exists():continue
  for current,dirs,files in os.walk(ext(area),followlinks=False):
   for name in files:
    f=pathlib.Path(current)/name
    if f.is_symlink():continue
    if header(f)==b'SQLite format 3\\x00':
     ok=sqlcheck(f);checks.append({'path':str(f),'integrity_ok':ok,'nonstandard_extension':f.suffix.lower() not in ['.db','.sqlite','.sqlite3'],'kind':'snapshot_or_history'});supplemental+=1
     if not ok:errors.append({'path':str(f),'error':'Supplemental SQLite integrity failed'})
 if not sqlcheck(R/'operator-index.sqlite3'):errors.append({'error':'Operator index integrity failed'})
 write('supplemental-sqlite-checks.json',{'checks':[v for v in checks if v.get('kind')!='mirror'],'operator_index_integrity_ok':not any(v.get('error')=='Operator index integrity failed' for v in errors)})
''' +s[a:]
s=s.replace("and len(checks)>=known", "and sum(v.get('kind')=='mirror' for v in checks)>=known")
s=s.replace("'source_sqlite_snapshots':sqlites,", "'source_sqlite_snapshots':sqlites,'mirror_sqlite_databases':sum(v.get('kind')=='mirror' for v in checks),'reconciled_reused_files':reconciliation['reconciled_rows'],'original_attempt_preserved':True,")
s=s.replace("if R.exists():write('failure.json',{'at':now(),'error_type':type(e).__name__});status('failed',error_type=type(e).__name__)","if R.exists():\n   write('failure.json',{'at':now(),'error_type':type(e).__name__,'message':str(e)});(R/'controller-error.txt').write_text(traceback.format_exc());status('failed',error_type=type(e).__name__)")
s=s.replace('archive-quiescent','archive-quiescent(?:-resume)?')
(p/'archive-quiescent-resume.py').write_text(s)
