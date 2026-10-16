"""Reconcile completed PC archive without executing Hermes or deleting/overwriting files."""
import pathlib,json,hashlib,sqlite3,datetime,time,shutil,subprocess,os
B=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016')
R=B/'reconcile-20261016'
PREFIX=chr(92)*2+'?'+chr(92)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def ext(p):return PREFIX+str(p)
def digest(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for v in iter(lambda:f.read(1024*1024),b''):h.update(v)
 return h.hexdigest()
def write(n,v):(R/n).write_text(json.dumps(v,indent=2)+'\n')
def safe(rel):
 q=pathlib.PureWindowsPath(rel)
 assert not q.is_absolute() and '..' not in q.parts and q.parts[0]=='mirror'
 return B.joinpath(*q.parts)
def main():
 R.mkdir(exist_ok=False);write('status.json',{'state':'reconciling','at':now()})
 v=json.loads((B/'verification.json').read_text());assert v['state']=='needs_review'
 errors=v['errors'];failed=[e for e in errors if 'path' in e];assert len(errors)==3220 and len(failed)==3219 and all(e['error']=='FileNotFoundError' for e in failed)
 assert len([e for e in errors if e.get('error')=='robocopy failure' and e.get('root')=='local-hermes' and e.get('code')==9])==1
 assert digest(B/'manifest.jsonl')==v['manifest_sha256']
 scope=json.loads((B/'scope.json').read_text());sources=dict(zip(scope['labels'],scope['roots']))
 unresolved=[];added=[];source_matches=0
 with (R/'manifest-addendum.jsonl').open('x') as out:
  for n,e in enumerate(failed):
   path=safe(e['path']);st=os.stat(ext(path));h=digest(path);parts=pathlib.PureWindowsPath(e['path']).parts;source=pathlib.Path(sources[parts[1]]).joinpath(*parts[2:]);source_hash=digest(source)
   if h!=source_hash:unresolved.append({'path':e['path'],'error':'archive/source hashes differ; originals preserved'})
   else:source_matches+=1
   rec={'path':e['path'],'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'ctime_ns':st.st_ctime_ns,'sha256':h,'reconciliation':'extended-length path; original payload already existed'};out.write(json.dumps(rec)+'\n');added.append(rec)
   if n%100==0:write('status.json',{'state':'hashing_exact_errors','at':now(),'resolved_paths_hashed':n+1})
  custody=pathlib.Path(r'C:\Users\nicho\backups\hermes-phase2-20261016\dashboard\supervisor.lock.final');expected='c734f9bd92fd5082d1c4d70f905a7fe37a8f6b61801209cbc4796314d84ccf88'
  assert custody.stat().st_size==37 and digest(custody)==expected
  target=B/'mirror'/'local-hermes'/'services'/'dashboard'/'supervisor.lock';assert not target.exists()
  with custody.open('rb') as src, target.open('xb') as dst:shutil.copyfileobj(src,dst)
  shutil.copystat(custody,target);assert digest(target)==expected
  st=target.stat();rec={'path':str(target.relative_to(B)),'bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'ctime_ns':st.st_ctime_ns,'sha256':expected,'reconciliation':'copied from separately preserved PC custody after dashboard observation/controller completion'};out.write(json.dumps(rec)+'\n');added.append(rec)
 write('error-reconciliation.json',{'at':now(),'original_errors':len(errors),'extended_paths':len(failed),'source_hash_matches':source_matches,'custody_lock_hash':expected,'unresolved':unresolved})
 checks=[];seen=0;header_errors=[];start=time.monotonic()
 with (R/'sqlite-all-checks.jsonl').open('x') as dbout:
  for manifest in [B/'manifest.jsonl',R/'manifest-addendum.jsonl']:
   with manifest.open() as stream:
    for line in stream:
     rec=json.loads(line);path=safe(rec['path']);seen+=1
     try:
      with open(ext(path),'rb') as f:header=f.read(16)
      if header==b'SQLite format 3\x00':
       c=sqlite3.connect(pathlib.Path(ext(path)).as_uri()+'?mode=ro&immutable=1',uri=True,timeout=10)
       deadline=time.monotonic()+180;c.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
       try:result=[r[0] for r in c.execute('pragma integrity_check')]
       finally:c.close()
       check={'path':rec['path'],'integrity_ok':result==['ok'],'nonstandard_extension':path.suffix.lower() not in ['.db','.sqlite','.sqlite3']};checks.append(check);dbout.write(json.dumps(check)+'\n');dbout.flush()
     except Exception as e:header_errors.append({'path':rec['path'],'error_type':type(e).__name__})
     if seen%10000==0:write('status.json',{'state':'sqlite_header_verification','at':now(),'files_headers_checked':seen,'sqlite_found':len(checks),'sqlite_integrity_ok':sum(x['integrity_ok'] for x in checks),'errors':len(header_errors),'elapsed_seconds':time.monotonic()-start})
 assert seen==v['files']+len(added)
 known=json.loads((B/'sqlite-checks.json').read_text());known_paths={x['snapshot'] for x in known if x.get('sqlite')};found={x['path'] for x in checks};missing_known=sorted(known_paths-found)
 sample=[]
 for item in v['restore_sample']:
  path=safe(item['path']);restored=B/'restore-test'/pathlib.PureWindowsPath(item['path']);sample.append({'path':item['path'],'original_sample':True,'hash_matches':digest(path)==digest(restored),'bytes_match':os.stat(ext(path)).st_size==os.stat(ext(restored)).st_size})
 for item in [added[0],added[-1]]:
  path=safe(item['path']);restored=R/'restore-test'/pathlib.PureWindowsPath(item['path']);os.makedirs(ext(restored.parent),exist_ok=True)
  with open(ext(path),'rb') as src,open(ext(restored),'xb') as dst:shutil.copyfileobj(src,dst)
  sample.append({'path':item['path'],'original_sample':False,'hash_matches':digest(restored)==item['sha256'],'bytes_match':os.stat(ext(restored)).st_size==item['bytes']})
 with (R/'lock-acl-command.log').open('xb') as log:acl_rc=subprocess.run(['icacls',str(target),'/save',str(R/'lock-acl.txt'),'/Q'],stdout=log,stderr=subprocess.STDOUT).returncode
 acl=B/'mirror-acls.txt';acl_ok=acl.exists() and acl.stat().st_size>0 and acl_rc==0
 verified=not unresolved and not header_errors and not missing_known and all(x['integrity_ok'] for x in checks) and all(x['hash_matches'] and x['bytes_match'] for x in sample) and acl_ok
 result={'state':'verified_reconciled_baseline' if verified else 'needs_review','at':now(),'original_manifest_preserved':True,'original_verification_preserved':True,'original_manifest_sha256':digest(B/'manifest.jsonl'),'manifest_addendum_sha256':digest(R/'manifest-addendum.jsonl'),'original_manifest_files':v['files'],'addendum_files':len(added),'files_header_checked':seen,'sqlite_databases':len(checks),'sqlite_integrity_ok':sum(x['integrity_ok'] for x in checks),'nonstandard_sqlite':sum(x['nonstandard_extension'] for x in checks),'missing_known_sqlite':missing_known,'header_errors':header_errors,'unresolved_original_errors':unresolved,'restore_sample':sample,'acl_export_ok':acl_ok,'original_acl_sha256':digest(acl) if acl.exists() else None,'lock_acl_sha256':digest(R/'lock-acl.txt') if (R/'lock-acl.txt').exists() else None,'final_seal':False,'limitations':v['limitations']}
 write('verification.json',result);write('status.json',result)
try:main()
except Exception as e:
 if R.exists():write('failure.json',{'at':now(),'error_type':type(e).__name__})
 raise
