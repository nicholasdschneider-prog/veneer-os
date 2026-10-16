"""PC-only sanitized recovery mirror; never invokes Hermes or any business script."""
import datetime as dt, hashlib, json, os, pathlib, re, shutil, sqlite3, subprocess, time
ROOT=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016')
SOURCES=[pathlib.Path(p) for p in [r'C:\Users\nicho\AppData\Local\hermes',r'C:\Users\nicho\.hermes',r'C:\Users\nicho\HermesBrainOps',r'C:\Users\nicho\HermesLegacyData',r'C:\Users\nicho\ObsidianVaults\Hermes Brain',r'C:\Users\nicho\.worktrees']]
LABELS=['local-hermes','dot-hermes','brain-ops','legacy-data','obsidian-brain','worktrees']
XD=['*secret*','*credential*','auth*','oauth*','*token*','.ssh','.aws','.azure','.gnupg','DPAPI','Protect','browser','browsers','browser-profiles','chrome-profile','chrome-profiles','User Data','ms-playwright']
XF=['.env*','*.env*','auth*','oauth*','*secret*','*password*','*api-key*','*apikey*','id_rsa*','id_ed25519*','config.json*','config.yaml*','config.yml*','config.toml*','settings.json*','settings.yaml*','settings.yml*','settings.toml*','*.pem*','*.key*','*.pfx*','*.p12*','*.dpapi*','session.json*','sessions.json*','.env','.env.*','*.pem','*.key','*.pfx','*.p12','*.dpapi','*credential*','*cookie*','*token*','auth.json','auth.yaml','auth.yml','auth.toml','session.json','sessions.json','*.session','Login Data*','Web Data*','Local State','config','config.json','config.yaml','config.yml','config.toml','settings.json','settings.yaml','settings.yml','settings.toml','*.env']
import fnmatch

def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def write(name,x):
 (ROOT/name).write_text(json.dumps(x,indent=2)+'\n',encoding='utf8')
def excluded(name,is_dir):return any(fnmatch.fnmatch(name.casefold(),v.casefold()) for v in (XD if is_dir else XF))
def emit(f,x):f.write(json.dumps(x,ensure_ascii=True)+'\n');f.flush()
def main():
 ROOT.mkdir(parents=True,exist_ok=True)
 if (ROOT/'status.json').exists():raise RuntimeError('Existing archive run: inspect status; do not replay')
 started=now();results=[];errors=[];dbs=[];sample=[];count=0;total=0
 write('status.json',{'state':'running','started':started,'final_seal':False,'note':'Held writers remain live; this is a recovery baseline, not a quiescent final seal.'})
 if shutil.disk_usage(ROOT).free<200*1024**3:raise RuntimeError('Less than 200 GiB free')
 write('scope.json',{'roots':[str(p) for p in SOURCES],'labels':LABELS,'exclude_dirs':XD,'exclude_files':XF,'credentials':'Excluded by metadata; original PC/account retained. Reauthentication required.','sessions':'Opaque non-credential histories copied locally; contents never exported.','reparse':'Not traversed; link metadata inventoried. External targets remain outside six-root scope.'})
 with (ROOT/'exclusions.jsonl').open('x',encoding='utf8') as exc,(ROOT/'reparse.jsonl').open('x',encoding='utf8') as links:
  for source,label in zip(SOURCES,LABELS):
   dest=ROOT/'mirror'/label
   if not source.exists():errors.append({'root':label,'error':'source missing'});continue
   # /E preserves all source files without purging or deleting destination files.
   cmd=['robocopy',str(source),str(dest),'/E','/COPY:DAT','/DCOPY:DAT','/XJ','/SL','/R:1','/W:1','/NP','/NFL','/NDL','/NJH','/NJS','/XD']+XD+['/XF']+XF+['*.db','*.sqlite','*.sqlite3','*-wal','*-shm','*-journal']
   with (ROOT/('robocopy-'+label+'.log')).open('xb') as log:
    rc=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT).returncode
   results.append({'root':label,'robocopy_exit':rc})
   if rc>=8:errors.append({'root':label,'error':'robocopy failure','code':rc})
   for current,dirs,files in os.walk(source,followlinks=False):
    base=pathlib.Path(current);retained=[]
    for name in dirs:
     p=base/name;rel=str(p.relative_to(source))
     if p.is_symlink() or p.is_junction():emit(links,{'root':label,'path':rel,'target':os.readlink(p)});continue
     if excluded(name,True):emit(exc,{'root':label,'path':rel,'kind':'directory','reason':'credential/browser metadata'});continue
     retained.append(name)
    dirs[:]=retained
    for name in files:
     p=base/name;rel=p.relative_to(source)
     if p.is_symlink():emit(links,{'root':label,'path':str(rel),'target':os.readlink(p)});continue
     if excluded(name,False):emit(exc,{'root':label,'path':str(rel),'kind':'file','reason':'credential/configuration metadata'});continue
     if p.suffix.casefold() in ['.db','.sqlite','.sqlite3']:dbs.append((p,dest/rel,label,str(rel)))
   write('status.json',{'state':'copying','started':started,'updated':now(),'roots_done':results,'final_seal':False})
 # Replace copied DBs with consistent SQLite backup API snapshots. Never query records.
 db_results=[]
 for source,dest,label,rel in dbs:
  record={'root':label,'path':rel};t=time.monotonic()
  try:
   with source.open('rb') as f:header=f.read(16)
   if header!=b'SQLite format 3\x00':
    dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest);record['sqlite']=False;db_results.append(record);continue
   # Database files were excluded from robocopy. Create only a consistent snapshot.
   snap=dest;snap.parent.mkdir(parents=True,exist_ok=True)
   if snap.exists():raise RuntimeError('Refuse to overwrite a prior database copy')
   sc=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=10)
   dc=sqlite3.connect(snap)
   try:
    def progress(status,remaining,total):
     if time.monotonic()-t>120:raise TimeoutError('SQLite backup deadline')
    sc.backup(dc,pages=1024,progress=progress,sleep=.05)
    check=[v[0] for v in dc.execute('PRAGMA integrity_check')]
    record.update(sqlite=True,integrity_ok=(check==['ok']),snapshot=str(snap.relative_to(ROOT)),sha256=digest(snap))
    if check!=['ok']:errors.append({'root':label,'path':rel,'error':'integrity_check failed'})
   finally:dc.close();sc.close()
  except Exception as e:
   record['error_type']=type(e).__name__;errors.append({'root':label,'path':rel,'error':type(e).__name__})
  db_results.append(record);write('sqlite-checks.json',db_results)
 # Hash every archive file in the mirror and consistent-snapshot tree.
 with (ROOT/'manifest.jsonl').open('x',encoding='utf8') as manifest:
  for area in ['mirror','sqlite-consistent']:
   for current,dirs,files in os.walk(ROOT/area,followlinks=False):
    base=pathlib.Path(current);dirs[:]=[n for n in dirs if not (base/n).is_symlink() and not (base/n).is_junction()]
    for name in files:
     p=base/name
     if p.is_symlink():continue
     try:
      st=p.stat();h=digest(p);rec={'path':str(p.relative_to(ROOT)),'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'ctime_ns':st.st_ctime_ns,'sha256':h}
      emit(manifest,rec);count+=1;total+=st.st_size
      # Independent restore/compare sample: at least one file from each top-level root.
      bucket=p.relative_to(ROOT).parts[:2]
      if len(sample)<40 and not any(tuple(v['bucket'])==bucket for v in sample):sample.append({'path':rec['path'],'sha256':h,'bucket':bucket})
     except OSError as e:errors.append({'path':str(p.relative_to(ROOT)),'error':type(e).__name__})
     if count%10000==0:write('status.json',{'state':'hashing','started':started,'updated':now(),'files_hashed':count,'bytes':total,'errors':len(errors),'final_seal':False})
 restore=[]
 for v in sample:
  src=ROOT/v['path'];dst=ROOT/'restore-test'/v['path'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
  restore.append({'path':v['path'],'hash_matches':digest(dst)==v['sha256'],'bytes_match':dst.stat().st_size==src.stat().st_size})
 # Save ACL metadata for recovery without printing it to the Mac.
 with (ROOT/'acl-command.log').open('xb') as log:
  acl_rc=subprocess.run(['icacls',str(ROOT/'mirror'),'/save',str(ROOT/'mirror-acls.txt'),'/T','/C','/Q'],stdout=log,stderr=subprocess.STDOUT).returncode
 if acl_rc:errors.append({'error':'ACL export failed','code':acl_rc})
 report={'state':'verified_baseline' if not errors and all(v['hash_matches'] for v in restore) else 'needs_review','started':started,'finished':now(),'files':count,'bytes':total,'roots':results,'sqlite_databases':sum(v.get('sqlite',False) for v in db_results),'sqlite_integrity_ok':sum(v.get('integrity_ok',False) for v in db_results),'restore_sample':restore,'manifest_sha256':digest(ROOT/'manifest.jsonl'),'errors':errors,'final_seal':False,'limitations':['Held writers remain live; refresh and seal after final cutover.','Credentials/configuration excluded by metadata; original PC/account custody required.','External reparse targets are inventoried, not followed.']}
 write('verification.json',report);write('status.json',report)
if __name__=='__main__':
 try:main()
 except Exception as e:
  ROOT.mkdir(parents=True,exist_ok=True);write('failure.json',{'at':now(),'error_type':type(e).__name__});raise
