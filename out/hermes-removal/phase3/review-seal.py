from pathlib import Path,PureWindowsPath
import json,hashlib,sqlite3,collections,ctypes,datetime,os
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-r3-20261022';X=chr(92)*2+'?'+chr(92)
def ext(p):return str(p) if str(p).startswith(X) else X+str(p)
def sha(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for v in iter(lambda:f.read(1024*1024),b''):h.update(v)
 return h.hexdigest()
def safe(p):
 buf=ctypes.create_unicode_buffer(32768);n=ctypes.windll.kernel32.GetShortPathNameW(ext(p),buf,len(buf))
 if n:
  assert os.path.samefile(buf.value,ext(p));return Path(buf.value[len(X):] if buf.value.startswith(X) else buf.value)
 assert len(str(p))<220;return p
v=json.loads((R/'verification.json').read_text());assert v['state']=='refresh_verified_pending_operator_seal' and not v['errors'] and not v['missing_source_files'];assert v['sqlite_databases']==v['sqlite_integrity_ok']==1410 and v['source_sqlite_snapshots']==v['mirror_sqlite_databases']==468
assert len(v['roots'])==6 and all(x['robocopy_exit']<8 for x in v['roots']) and v['acl_export_ok'];assert v['original_records_preserved'] and v['both_stopped_attempts_preserved']
checks={};rootcounts=collections.Counter();n=total=0
for line in (R/'manifest-current.jsonl').open():
 row=json.loads(line);parts=PureWindowsPath(row['path']).parts;assert parts[0]=='mirror' and len(parts)>2 and '..' not in parts;assert len(row['sha256'])==64 and row['bytes']>=0;n+=1;total+=row['bytes'];rootcounts[parts[1]]+=1
assert n==v['files'] and total==v['bytes'] and len(rootcounts)==6
for name,key in [('manifest-current.jsonl','manifest_sha256'),('manifest-addendum.jsonl','manifest_addendum_sha256'),('baseline-corrections.jsonl','baseline_correction_sha256')]:checks[name]=sha(R/name);assert checks[name]==v[key]
originals=json.loads((R/'original-records.json').read_text());assert all(sha(B/PureWindowsPath(k))==h for k,h in originals.items())
source=sqlite3.connect((R/'operator-index.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True);cnt=source.execute('select count(*),sum(seen),sum(is_sqlite) from source').fetchone();assert cnt==(v['source_files'],v['source_files'],468);source.close()
mirrorchecks=[json.loads(line) for line in (R/'sqlite-all-checks.jsonl').open()];supp=json.loads((R/'supplemental-sqlite-checks.json').read_text());assert len(mirrorchecks)==468 and all(x['integrity_ok'] for x in mirrorchecks) and supp['operator_index_integrity_ok'];assert len(supp['checks'])+len(mirrorchecks)==1410 and all(x['integrity_ok'] for x in supp['checks'])
for x in mirrorchecks+supp['checks']:
 p=B/PureWindowsPath(x['path']) if x['kind']=='mirror' else Path(x['path']);assert os.path.isfile(ext(p))
 with open(ext(p),'rb') as f:assert f.read(16)==b'SQLite format 3\x00'
restores=[]
for x in v['restore_sample']:
 src=B/PureWindowsPath(x['path']);dst=R/'restore-test'/PureWindowsPath(x['path']);assert sha(src)==sha(dst) and os.stat(ext(src)).st_size==os.stat(ext(dst)).st_size
 ok=True
 with open(ext(dst),'rb') as f:isdb=f.read(16)==b'SQLite format 3\x00'
 if isdb:
  c=sqlite3.connect(safe(dst).as_uri()+'?mode=ro&immutable=1',uri=True);ok=[r[0] for r in c.execute('pragma integrity_check')]==['ok'];c.close();assert ok
 restores.append({'path':x['path'],'hash_and_size_match':True,'sqlite_integrity_ok':ok})
assert len(restores)==6 and all(all(x[k]==0 for k in ['processes','enabled_tasks','active_startup','enabled_cron']) for x in v['quiescence_checks'])
assert (R/'mirror-acls.txt').stat().st_size>0
correction=[json.loads(x) for x in (R/'baseline-corrections.jsonl').read_text().splitlines()];assert len(correction)==1 and sha(B/PureWindowsPath(correction[0]['path']))==correction[0]['sha256']
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_root':str(B),'attempt':str(R),'independent_archive_review_passed':True,'files':n,'bytes':total,'source_rows':cnt[0],'source_rows_seen':cnt[1],'source_sqlite':cnt[2],'root_counts':dict(rootcounts),'manifest_hashes':checks,'verification_sha256':sha(R/'verification.json'),'sqlite_reported_checks':1410,'sqlite_headers_independently_confirmed':1410,'sqlite_reported_all_integrity_ok':True,'restores_rechecked':restores,'acl_metadata_present':True,'original_manifest_hashes_unchanged':True,'reserved_correction_exact':True,'fresh_quiescence_required':True,'sealed':False}
with (R/'independent-review.json').open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
