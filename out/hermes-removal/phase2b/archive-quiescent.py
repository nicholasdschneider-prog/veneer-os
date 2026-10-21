"""Isolated PC-only incremental recovery refresh. Never invokes Hermes or deletes files."""
import pathlib,os,json,hashlib,sqlite3,datetime,time,shutil,subprocess,fnmatch
B=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-20261021'
PREFIX=chr(92)*2+'?'+chr(92)
def ext(p):return PREFIX+str(p) if not str(p).startswith(PREFIX) else str(p)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def write(n,v):
 p=R/n;tmp=R/(n+'.next');tmp.write_text(json.dumps(v,indent=2)+'\n',encoding='utf8');os.replace(tmp,p)
def status(state,**v):write('status.json',{'state':state,'at':now(),'final_seal':False,**v})
def copy_new(a,b):
 os.makedirs(ext(b.parent),exist_ok=True)
 with open(ext(a),'rb') as src,open(ext(b),'xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
 shutil.copystat(ext(a),ext(b))
def sqlcheck(p):
 c=sqlite3.connect(pathlib.Path(ext(p)).as_uri()+'?mode=ro&immutable=1',uri=True,timeout=10);deadline=time.monotonic()+300
 c.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
 try:return [r[0] for r in c.execute('pragma integrity_check')]==['ok']
 finally:c.close()
def header(p):
 with open(ext(p),'rb') as f:return f.read(16)
def guard():
 # Runs no business script; only reads task/process metadata and job flags.
 ps=r'''$ErrorActionPreference='Stop';$b='C:\Users\nicho\AppData\Local\hermes';$files=@(Get-Item "$b\cron\jobs.json")+@(Get-ChildItem "$b\profiles\*\cron\jobs.json");$enabled=0;foreach($f in $files){$d=Get-Content $f.FullName -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)};$enabled+=@($jobs|Where-Object{$_.enabled}).Count};$tasks=@(Get-ScheduledTask|Where-Object{$_.Settings.Enabled -and ($_.TaskName -match 'Hermes|^ERVP_Orders_Bot_' -or @($_.Actions|Where-Object{($_.Execute+' '+$_.Arguments) -match 'AppData\\Local\\hermes|HermesBrainOps|Sync-HermesBrain'}).Count)});$procs=@(Get-CimInstance Win32_Process|Where-Object{$c=[string]$_.CommandLine;$_.ProcessId -ne $PID -and ($c -match 'gateway\s+run|AppData\\Local\\hermes|HermesBrainOps|Sync-HermesBrain|production_owner_policy_cycle|every_order_review') -and $c -notmatch 'backups\\hermes-final-20261016\\archive-quiescent\.py'});$startup=@();foreach($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup","$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp")){$startup+=@(Get-ChildItem $d -File|Where-Object{$_.Name -match 'Hermes' -and $_.Extension -in '.vbs','.cmd','.bat','.lnk','.exe'})};@{at=(Get-Date).ToUniversalTime().ToString('o');enabled_cron=$enabled;enabled_tasks=$tasks.Count;processes=$procs.Count;active_startup=$startup.Count}|ConvertTo-Json -Compress'''
 out=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',ps],capture_output=True,text=True,timeout=90)
 if out.returncode:raise RuntimeError('Quiescence metadata guard failed')
 v=json.loads(out.stdout.lstrip('\ufeff'))
 if any(v[k] for k in ['enabled_cron','enabled_tasks','processes','active_startup']):raise RuntimeError('Quiescence lost; no verified seal')
 return v

def main():
 if R.exists():raise RuntimeError('Existing refresh directory: inspect status and identity; never relaunch blindly')
 R.mkdir();status('starting');scope=json.loads((B/'scope.json').read_text());old=json.loads((B/'reconcile-20261016/verification.json').read_text());assert old['state']=='verified_reconciled_baseline'
 guards=[guard()];write('quiescence.json',guards)
 if shutil.disk_usage(B).free<200*1024**3:raise RuntimeError('Insufficient custody/version headroom')
 originals={str(p.relative_to(B)):sha(p) for p in [B/'manifest.jsonl',B/'verification.json',B/'scope.json',B/'reconcile-20261016/manifest-addendum.jsonl',B/'reconcile-20261016/verification.json']};write('original-records.json',originals)
 sources=[pathlib.Path(v) for v in scope['roots']];labels=scope['labels'];xd=scope['exclude_dirs'];xf=scope['exclude_files'];write('scope.json',scope)
 def excluded(n,isdir):return any(fnmatch.fnmatch(n.lower(),v.lower()) for v in (xd if isdir else xf))
 db=sqlite3.connect(R/'operator-index.sqlite3');db.execute('create table baseline(path text primary key,sha text)');db.execute('create table source(path text primary key,source_path text,size integer,mtime integer,expected_sha text,is_sqlite integer,snapshot text,seen integer default 0)')
 for m in [B/'manifest.jsonl',B/'reconcile-20261016/manifest-addendum.jsonl']:
  with m.open() as f:
   batch=[]
   for line in f:
    v=json.loads(line);batch.append((str(pathlib.PureWindowsPath(v['path'])),v['sha256']))
    if len(batch)==10000:db.executemany('insert or replace into baseline values(?,?)',batch);batch=[]
   db.executemany('insert or replace into baseline values(?,?)',batch);db.commit()
 n=0;versions=0;sqlites=0;errors=[];roots=[];changed=set()
 with (R/'source-inventory.jsonl').open('x') as inv,(R/'versions.jsonl').open('x') as ver,(R/'exclusions.jsonl').open('x') as exc,(R/'reparse.jsonl').open('x') as links:
  for source,label in zip(sources,labels):
   if not source.is_dir():raise RuntimeError('Six-root source missing')
   for current,dirs,files in os.walk(ext(source),followlinks=False):
    base=pathlib.Path(current);relbase=pathlib.PureWindowsPath(str(base)[len(PREFIX):]).relative_to(source);kept=[]
    for name in dirs:
     p=base/name
     if p.is_symlink() or p.is_junction():links.write(json.dumps({'root':label,'path':str(relbase/name),'link':True})+'\n')
     elif excluded(name,True):exc.write(json.dumps({'root':label,'path':str(relbase/name),'kind':'directory'})+'\n')
     else:kept.append(name)
    dirs[:]=kept
    for name in files:
     p=base/name;rel=relbase/name;target=B/'mirror'/label/rel;key=str(pathlib.PureWindowsPath('mirror')/label/rel)
     if p.is_symlink():links.write(json.dumps({'root':label,'path':str(rel),'link':True})+'\n');continue
     if excluded(name,False) or name.endswith(('-wal','-shm','-journal')):exc.write(json.dumps({'root':label,'path':str(rel),'kind':'file'})+'\n');continue
     st=p.stat();isdb=header(p)==b'SQLite format 3\x00';snapshot=None
     if isdb:
      snapshot=R/'sqlite-current'/label/rel;os.makedirs(ext(snapshot.parent),exist_ok=True)
      sc=sqlite3.connect(pathlib.Path(str(p)).as_uri()+'?mode=ro',uri=True,timeout=10);dc=sqlite3.connect(ext(snapshot));deadline=time.monotonic()+300
      try:
       def progress(s,r,t):
        if time.monotonic()>deadline:raise TimeoutError('SQLite snapshot deadline')
       sc.backup(dc,pages=1024,progress=progress,sleep=.05)
      finally:dc.close();sc.close()
      if not sqlcheck(snapshot):raise RuntimeError('SQLite snapshot integrity failure')
      expected=sha(snapshot);sqlites+=1
     else:expected=sha(p)
     if p.stat().st_mtime_ns!=st.st_mtime_ns or p.stat().st_size!=st.st_size:raise RuntimeError('Source writer changed during capture')
     row=db.execute('select sha from baseline where path=?',(key,)).fetchone();prior=row[0] if row else (sha(target) if os.path.isfile(ext(target)) else None)
     if prior is not None and (prior!=expected or isdb or os.stat(ext(target)).st_mtime_ns!=st.st_mtime_ns):
      history=R/'previous-payload'/label/rel;copy_new(target,history)
      if sha(history)!=prior:raise RuntimeError('Prior baseline payload hash mismatch')
      if header(history)==b'SQLite format 3\x00' and not sqlcheck(history):raise RuntimeError('Historical SQLite integrity failure')
      ver.write(json.dumps({'path':key,'previous_payload':str(history.relative_to(B)),'sha256':prior})+'\n');versions+=1
     if prior!=expected:changed.add(key)
     record={'path':key,'source':str(source/rel),'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'sha256':expected,'sqlite':isdb,'snapshot':str(snapshot.relative_to(B)) if snapshot else None};inv.write(json.dumps(record)+'\n')
     db.execute('insert into source(path,source_path,size,mtime,expected_sha,is_sqlite,snapshot) values(?,?,?,?,?,?,?)',(key,str(source/rel),st.st_size,st.st_mtime_ns,expected,int(isdb),str(snapshot) if snapshot else None));n+=1
     if n%10000==0:db.commit();status('source_hash_and_version_preservation',files=n,sqlite_found=sqlites,previous_versions=versions)
   db.commit();guards.append(guard());write('quiescence.json',guards)
   # Incremental /E, never /MIR or /PURGE. Every destination change has prior payload custody.
   cmd=['robocopy',str(source),str(B/'mirror'/label),'/E','/COPY:DAT','/DCOPY:DAT','/XJ','/SL','/R:1','/W:1','/NP','/NFL','/NDL','/NJH','/NJS','/XD',*xd,'/XF',*xf,'*.db','*.sqlite','*.sqlite3','*-wal','*-shm','*-journal']
   with (R/('robocopy-'+label+'.log')).open('xb') as log:rc=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT).returncode
   roots.append({'root':label,'robocopy_exit':rc})
   if rc>=8:errors.append({'root':label,'error':'robocopy failure','code':rc})
   # Install consistent SQLite copies (including nonstandard extensions) and repair same-metadata hash changes.
   for key,sp,expected,isdb,snapshot in db.execute('select path,source_path,expected_sha,is_sqlite,snapshot from source where path like ?',('mirror\\'+label+'\\%',)):
    dest=B/pathlib.PureWindowsPath(key)
    if isdb or not os.path.isfile(ext(dest)) or (key in changed and sha(dest)!=expected):
     os.makedirs(ext(dest.parent),exist_ok=True);shutil.copy2(ext(pathlib.Path(snapshot if isdb else sp)),ext(dest))
   status('incremental_copy',roots=roots,source_files=n,sqlite_found=sqlites,previous_versions=versions)
 checks=[];count=0;total=0;sample={};missing=[]
 with (R/'manifest-current.jsonl').open('x') as manifest,(R/'manifest-addendum.jsonl').open('x') as add,(R/'sqlite-all-checks.jsonl').open('x') as sq:
  for current,dirs,files in os.walk(ext(B/'mirror'),followlinks=False):
   base=pathlib.Path(current);dirs[:]=[v for v in dirs if not (base/v).is_symlink() and not (base/v).is_junction()]
   for name in files:
    p=base/name
    if p.is_symlink():continue
    rel=str(pathlib.PureWindowsPath(str(p)[len(PREFIX):]).relative_to(B));st=p.stat();h=sha(p);rec={'path':rel,'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'sha256':h};manifest.write(json.dumps(rec)+'\n')
    src=db.execute('select source_path,size,mtime,expected_sha,is_sqlite from source where path=?',(rel,)).fetchone()
    if src:
     if h!=src[3]:errors.append({'path':rel,'error':'current archive/source expected hash mismatch'})
     ss=os.stat(ext(pathlib.Path(src[0])))
     if ss.st_size!=src[1] or ss.st_mtime_ns!=src[2]:errors.append({'path':rel,'error':'source changed after snapshot'})
     db.execute('update source set seen=1 where path=?',(rel,))
    oldhash=db.execute('select sha from baseline where path=?',(rel,)).fetchone()
    if not oldhash or h!=oldhash[0]:add.write(json.dumps(rec)+'\n')
    if header(p)==b'SQLite format 3\x00':
     ok=sqlcheck(p);v={'path':rel,'integrity_ok':ok,'nonstandard_extension':p.suffix.lower() not in ['.db','.sqlite','.sqlite3']};checks.append(v);sq.write(json.dumps(v)+'\n');sq.flush()
     if not ok:errors.append({'path':rel,'error':'SQLite integrity failed'})
    bucket=pathlib.PureWindowsPath(rel).parts[1]
    if bucket not in sample:sample[bucket]=rec
    count+=1;total+=st.st_size
    if count%10000==0:db.commit();status('archive_hash_header_verification',files=count,bytes=total,sqlite_found=len(checks),sqlite_integrity_ok=sum(v['integrity_ok'] for v in checks),errors=len(errors))
  db.commit();missing=[v[0] for v in db.execute('select path from source where seen=0')]
 restores=[]
 for rec in sample.values():
  source=B/pathlib.PureWindowsPath(rec['path']);dest=R/'restore-test'/pathlib.PureWindowsPath(rec['path']);copy_new(source,dest);restores.append({'path':rec['path'],'hash_matches':sha(dest)==rec['sha256'],'bytes_match':os.stat(ext(dest)).st_size==rec['bytes']})
 with (R/'acl-command.log').open('xb') as log:acl_rc=subprocess.run(['icacls',str(B/'mirror'),'/save',str(R/'mirror-acls.txt'),'/T','/C','/Q'],stdout=log,stderr=subprocess.STDOUT).returncode
 guards.append(guard());write('quiescence.json',guards)
 preserved=all(sha(B/pathlib.PureWindowsPath(k))==v for k,v in originals.items());known=json.loads((B/'reconcile-20261016/verification.json').read_text())['sqlite_databases']
 verified=not errors and not missing and preserved and len(restores)==6 and all(v['hash_matches'] and v['bytes_match'] for v in restores) and all(v['integrity_ok'] for v in checks) and len(checks)>=known and acl_rc==0
 report={'state':'refresh_verified_pending_operator_seal' if verified else 'needs_review','at':now(),'files':count,'bytes':total,'source_files':n,'previous_versions':versions,'roots':roots,'sqlite_databases':len(checks),'sqlite_integrity_ok':sum(v['integrity_ok'] for v in checks),'source_sqlite_snapshots':sqlites,'nonstandard_sqlite':sum(v['nonstandard_extension'] for v in checks),'original_records_preserved':preserved,'missing_source_files':missing,'errors':errors,'restore_sample':restores,'manifest_sha256':sha(R/'manifest-current.jsonl'),'manifest_addendum_sha256':sha(R/'manifest-addendum.jsonl'),'acl_export_ok':acl_rc==0,'quiescence_checks':guards,'final_seal':False,'pending':['Independent operator readback and late LTL confirmation before sealed verdict.'],'limitations':scope.get('credentials','Credentials/configuration excluded by metadata; account custody/reauthentication required.')}
 write('verification.json',report);write('status.json',report);db.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  if R.exists():write('failure.json',{'at':now(),'error_type':type(e).__name__});status('failed',error_type=type(e).__name__)
  raise
