"""Isolated PC-only incremental recovery refresh. Never invokes Hermes or deletes files."""
import pathlib,os,json,hashlib,sqlite3,datetime,time,shutil,subprocess,fnmatch,ctypes,traceback
B=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-r3-20261022';OLD=B/'quiescent-20261021';PREV=B/'quiescent-resume-20261021'
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
def reserved(p):
 import re
 return bool(re.fullmatch(r'(NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])(?:\..*)?',pathlib.PureWindowsPath(str(p)).name.rstrip(' .'),re.I))
def sqlite_path(p,immutable=True):
 normal=pathlib.Path(str(p)[len(PREFIX):] if str(p).startswith(PREFIX) else str(p))
 buf=ctypes.create_unicode_buffer(32768);n=ctypes.windll.kernel32.GetShortPathNameW(ext(normal),buf,len(buf))
 if n and n<len(buf):
  alias=buf.value
  if not os.path.samefile(alias,ext(normal)):raise RuntimeError('SQLite short-path identity mismatch')
  candidate=pathlib.Path(alias[len(PREFIX):] if alias.startswith(PREFIX) else alias)
  if len(str(candidate))<220 and not reserved(candidate):
   with (R/'sqlite-access.jsonl').open('a') as f:f.write(json.dumps({'source':str(normal),'method':'verified_8dot3','identity_matches':True,'alias_chars':len(str(candidate))})+'\n')
   return candidate
 if len(str(normal))<220 and not reserved(normal):
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
 with (R/'sqlite-access.jsonl').open('a') as f:f.write(json.dumps({'source':str(normal),'method':'verified_extended_handle_copy','custody':str(target),'sha256':h})+'\n')
 return target

def sqlopen(p,readonly=True,immutable=True):
 safe=sqlite_path(p,immutable)
 return sqlite3.connect(safe.as_uri()+('?mode=ro'+('&immutable=1' if immutable else '') if readonly else '?mode=rw'),uri=True,timeout=10)

def sqlcheck(p):
 c=sqlopen(p);deadline=time.monotonic()+300
 c.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
 try:return [r[0] for r in c.execute('pragma integrity_check')]==['ok']
 finally:c.close()
def header(p):
 with open(ext(p),'rb') as f:return f.read(16)
def guard():
 # Runs no business script; only reads task/process metadata and job flags.
 ps=r'''$ErrorActionPreference='Stop';$b='C:\Users\nicho\AppData\Local\hermes';$files=@(Get-Item "$b\cron\jobs.json")+@(Get-ChildItem "$b\profiles\*\cron\jobs.json");$enabled=0;foreach($f in $files){$d=Get-Content $f.FullName -Raw|ConvertFrom-Json;$jobs=if($null -ne $d.jobs){@($d.jobs)}else{@($d)};$enabled+=@($jobs|Where-Object{$_.enabled}).Count};$tasks=@(Get-ScheduledTask|Where-Object{$_.Settings.Enabled -and ($_.TaskName -match 'Hermes|^ERVP_Orders_Bot_' -or @($_.Actions|Where-Object{($_.Execute+' '+$_.Arguments) -match 'AppData\\Local\\hermes|HermesBrainOps|Sync-HermesBrain'}).Count)});$procs=@(Get-CimInstance Win32_Process|Where-Object{$c=[string]$_.CommandLine;$_.ProcessId -ne $PID -and ($c -match 'gateway\s+run|AppData\\Local\\hermes|HermesBrainOps|Sync-HermesBrain|production_owner_policy_cycle|every_order_review') -and $c -notmatch 'backups\\hermes-final-20261016\\archive-quiescent(?:-resume|-r3)?\.py'});$startup=@();foreach($d in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup","$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp")){$startup+=@(Get-ChildItem $d -File|Where-Object{$_.Name -match 'Hermes' -and $_.Extension -in '.vbs','.cmd','.bat','.lnk','.exe'})};@{at=(Get-Date).ToUniversalTime().ToString('o');enabled_cron=$enabled;enabled_tasks=$tasks.Count;processes=$procs.Count;active_startup=$startup.Count}|ConvertTo-Json -Compress'''
 out=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',ps],capture_output=True,text=True,timeout=90)
 if out.returncode:raise RuntimeError('Quiescence metadata guard failed')
 v=json.loads(out.stdout.lstrip('\ufeff'))
 if any(v[k] for k in ['enabled_cron','enabled_tasks','processes','active_startup']):raise RuntimeError('Quiescence lost; no verified seal')
 return v

def main():
 reconciliation=json.loads((R/'reconciliation.json').read_text())
 if reconciliation['state']!='reconciled_ready' or reconciliation['unresolved']:raise RuntimeError('Reconciliation prerequisite failed')
 if (R/'refresh-status-started.json').exists():raise RuntimeError('Third launch already started: inspect before replay')
 write('refresh-status-started.json',{'at':now(),'launch_attempts':1})
 correction_file=R/'baseline-corrections.jsonl'
 if sha(correction_file)!=reconciliation['correction_sha256']:raise RuntimeError('Correction addendum SHA mismatch')
 corrections={v['path']:v for v in (json.loads(line) for line in correction_file.read_text().splitlines())}
 for v in corrections.values():
  if v['sha256']!=v['mirror_sha256'] or v['sha256']!=v['extended_read_sha256']:raise RuntimeError('Correction values diverge')
 status('resume_starting');scope=json.loads((B/'scope.json').read_text());old=json.loads((B/'reconcile-20261016/verification.json').read_text());assert old['state']=='verified_reconciled_baseline'
 guards=[guard()];write('quiescence.json',guards)
 if shutil.disk_usage(B).free<200*1024**3:raise RuntimeError('Insufficient custody/version headroom')
 originals={str(p.relative_to(B)):sha(p) for p in [B/'manifest.jsonl',B/'verification.json',B/'scope.json',B/'reconcile-20261016/manifest-addendum.jsonl',B/'reconcile-20261016/verification.json']};write('original-records.json',originals)
 sources=[pathlib.Path(v) for v in scope['roots']];labels=scope['labels'];xd=scope['exclude_dirs'];xf=scope['exclude_files'];write('scope.json',scope)
 def excluded(n,isdir):return any(fnmatch.fnmatch(n.lower(),v.lower()) for v in (xd if isdir else xf))
 db=sqlite3.connect(R/'operator-index.sqlite3')
 assert db.execute('select count(*) from source').fetchone()[0]==reconciliation['reconciled_rows']
 db.execute('update source set seen=0');db.commit()
 n=0;versions=reconciliation['prior_version_count'];sqlites=0;errors=[];roots=[];changed={r[0] for r in db.execute('select s.path from source s left join baseline b on b.path=s.path where b.sha is null or b.sha!=s.expected_sha')}
 with (R/'source-inventory.jsonl').open('x') as inv,(R/'versions.jsonl').open('x') as ver,(R/'exclusions.jsonl').open('x') as exc,(R/'reparse.jsonl').open('x') as links:
  with (R/'reconciled-versions.jsonl').open() as existing_versions:
   for line in existing_versions:ver.write(line)
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
     previous=db.execute('select source_path,size,mtime,expected_sha,is_sqlite,snapshot from source where path=?',(key,)).fetchone()
     if previous:
      st=p.stat()
      if st.st_size!=previous[1] or st.st_mtime_ns!=previous[2]:raise RuntimeError('Reconciled source metadata changed; stop')
      record={'path':key,'source':previous[0],'bytes':previous[1],'mtime_ns':previous[2],'sha256':previous[3],'sqlite':bool(previous[4]),'snapshot':str(pathlib.Path(previous[5]).relative_to(B)) if previous[5] else None,'reused_reconciled_capture':True};inv.write(json.dumps(record)+'\n')
      n+=1;sqlites+=int(previous[4])
      if n%10000==0:status('resume_reusing_or_hashing_source',files=n,sqlite_found=sqlites,previous_versions=versions,reconciled_source_rows=reconciliation['reconciled_rows'])
      continue
     st=p.stat();isdb=header(p)==b'SQLite format 3\x00';snapshot=None
     if isdb:
      snapshot=R/'sqlite-current-flat'/(hashlib.sha256(key.encode()).hexdigest()+'.sqlite3');os.makedirs(ext(snapshot.parent),exist_ok=True)
      with open(ext(snapshot),'xb'):pass
      sc=sqlopen(p,immutable=False);dc=sqlopen(snapshot,readonly=False);deadline=time.monotonic()+300
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
      actual_prior=sha(history)
      if actual_prior!=prior:
       correction=corrections.get(key)
       if not correction or correction['baseline_sha256']!=prior or correction['sha256']!=actual_prior:raise RuntimeError('Unapproved prior baseline payload hash mismatch')
       prior=actual_prior
       with (R/'applied-corrections.jsonl').open('a') as applied:applied.write(json.dumps({'path':key,'correction_sha256':reconciliation['correction_sha256'],'baseline_sha256':correction['baseline_sha256'],'verified_prior_sha256':actual_prior})+'\n')
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
     ok=sqlcheck(p);v={'path':rel,'integrity_ok':ok,'nonstandard_extension':p.suffix.lower() not in ['.db','.sqlite','.sqlite3'],'kind':'mirror'};checks.append(v);sq.write(json.dumps(v)+'\n');sq.flush()
     if not ok:errors.append({'path':rel,'error':'SQLite integrity failed'})
    bucket=pathlib.PureWindowsPath(rel).parts[1]
    if bucket not in sample:sample[bucket]=rec
    count+=1;total+=st.st_size
    if count%10000==0:db.commit();status('archive_hash_header_verification',files=count,bytes=total,sqlite_found=len(checks),sqlite_integrity_ok=sum(v['integrity_ok'] for v in checks),errors=len(errors))
  db.commit();missing=[v[0] for v in db.execute('select path from source where seen=0')]
 # Validate all new/reused historical and snapshot SQLite copies, regardless extension.
 supplemental=0;db.close()
 for current,dirs,files in os.walk(ext(B),followlinks=False):
  base=pathlib.Path(current)
  dirs[:]=[n for n in dirs if not (base/n).is_symlink() and not (base/n).is_junction() and not (base==pathlib.Path(ext(B)) and n.lower()=='mirror')]
  for name in files:
   f=base/name
   if f.is_symlink():continue
   if header(f)==b'SQLite format 3\x00':
    ok=sqlcheck(f);checks.append({'path':str(f),'integrity_ok':ok,'nonstandard_extension':f.suffix.lower() not in ['.db','.sqlite','.sqlite3'],'kind':'snapshot_or_history'});supplemental+=1
    if not ok:errors.append({'path':str(f),'error':'Supplemental SQLite integrity failed'})
 if not sqlcheck(R/'operator-index.sqlite3'):errors.append({'error':'Operator index integrity failed'})
 write('supplemental-sqlite-checks.json',{'checks':[v for v in checks if v.get('kind')!='mirror'],'operator_index_integrity_ok':not any(v.get('error')=='Operator index integrity failed' for v in errors)})
 restores=[]
 for rec in sample.values():
  source=B/pathlib.PureWindowsPath(rec['path']);dest=R/'restore-test'/pathlib.PureWindowsPath(rec['path']);copy_new(source,dest);restores.append({'path':rec['path'],'hash_matches':sha(dest)==rec['sha256'],'bytes_match':os.stat(ext(dest)).st_size==rec['bytes'],'sqlite_integrity_ok':sqlcheck(dest) if header(dest)==b'SQLite format 3\x00' else True})
 with (R/'acl-command.log').open('xb') as log:acl_rc=subprocess.run(['icacls',str(B/'mirror'),'/save',str(R/'mirror-acls.txt'),'/T','/C','/Q'],stdout=log,stderr=subprocess.STDOUT).returncode
 guards.append(guard());write('quiescence.json',guards)
 preserved=all(sha(B/pathlib.PureWindowsPath(k))==v for k,v in originals.items());known=json.loads((B/'reconcile-20261016/verification.json').read_text())['sqlite_databases']
 verified=not errors and not missing and preserved and len(restores)==6 and all(v['hash_matches'] and v['bytes_match'] and v['sqlite_integrity_ok'] for v in restores) and all(v['integrity_ok'] for v in checks) and sum(v.get('kind')=='mirror' for v in checks)>=known and acl_rc==0
 report={'state':'refresh_verified_pending_operator_seal' if verified else 'needs_review','at':now(),'files':count,'bytes':total,'source_files':n,'previous_versions':versions,'roots':roots,'sqlite_databases':len(checks),'sqlite_integrity_ok':sum(v['integrity_ok'] for v in checks),'source_sqlite_snapshots':sqlites,'mirror_sqlite_databases':sum(v.get('kind')=='mirror' for v in checks),'reconciled_reused_files':reconciliation['reconciled_rows'],'original_attempt_preserved':True,'nonstandard_sqlite':sum(v['nonstandard_extension'] for v in checks),'original_records_preserved':preserved,'missing_source_files':missing,'errors':errors,'restore_sample':restores,'manifest_sha256':sha(R/'manifest-current.jsonl'),'manifest_addendum_sha256':sha(R/'manifest-addendum.jsonl'),'acl_export_ok':acl_rc==0,'quiescence_checks':guards,'baseline_correction_sha256':sha(R/'baseline-corrections.jsonl'),'baseline_correction_count':len(corrections),'both_stopped_attempts_preserved':True,'final_seal':False,'pending':['Independent operator readback before sealed verdict; Brain and late LTL confirmations already verified.'],'limitations':scope.get('credentials','Credentials/configuration excluded by metadata; account custody/reauthentication required.')}
 write('verification.json',report);write('status.json',report);db.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  if R.exists():
   write('failure.json',{'at':now(),'error_type':type(e).__name__,'message':str(e)});(R/'controller-error.txt').write_text(traceback.format_exc());status('failed',error_type=type(e).__name__)
  raise
