"""Preserve old attempt; reconcile its finite inventory into a NEW resume index."""
from pathlib import Path
import json,sqlite3,hashlib,os,datetime,ctypes,time
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');OLD=B/'quiescent-20261021';R=B/'quiescent-resume-20261021';P=chr(92)*2+'?'+chr(92)
def ext(p):return str(p) if str(p).startswith(P) else P+str(p)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def write(n,v):
 tmp=R/(n+'.next');tmp.write_text(json.dumps(v,indent=2)+'\n');os.replace(tmp,R/n)
def short(p):
 buf=ctypes.create_unicode_buffer(32768);n=ctypes.windll.kernel32.GetShortPathNameW(ext(p),buf,len(buf))
 if n and n<len(buf):
  alias=buf.value
  if not os.path.samefile(alias,ext(p)):raise RuntimeError('Short-path identity mismatch')
  if alias.startswith(P):alias=alias[len(P):]
  return Path(alias)
 if len(str(p))<220:return p
 raise RuntimeError('Reconciliation requires verified short alias; preserve originals on failure')
def main():
 if R.exists():raise RuntimeError('Resume directory exists: inspect existing reconciliation, never repeat')
 if json.loads((OLD/'failure.json').read_text())['error_type']!='OperationalError':raise RuntimeError('Original failure changed')
 R.mkdir();write('reconcile-status.json',{'state':'copying_index','at':now()})
 original_files=['operator-index.sqlite3','source-inventory.jsonl','versions.jsonl','failure.json','status.json','original-records.json'];before={n:digest(OLD/n) for n in original_files};write('preserved-attempt-hashes.json',before)
 src=sqlite3.connect(short(OLD/'operator-index.sqlite3').as_uri()+'?mode=ro',uri=True);dst=sqlite3.connect(R/'operator-index.sqlite3')
 try:src.backup(dst,pages=4096,sleep=.02)
 finally:src.close();dst.close()
 db=sqlite3.connect(R/'operator-index.sqlite3');committed=db.execute('select count(*) from source').fetchone()[0];stream_count=0;added=0;matched=0;sqlite_rows=[]
 with (OLD/'source-inventory.jsonl').open() as f:
  for line in f:
   v=json.loads(line);key=str(Path(v['path']));parts=Path(key).parts
   if parts[0]!='mirror' or '..' in parts:raise RuntimeError('Inventory path outside archive')
   old=db.execute('select source_path,size,mtime,expected_sha,is_sqlite,snapshot from source where path=?',(key,)).fetchone();snapshot=str(B/Path(v['snapshot'])) if v.get('snapshot') else None;row=(v['source'],v['bytes'],v['mtime_ns'],v['sha256'],int(v['sqlite']),snapshot)
   if old:
    if tuple(old)!=row:raise RuntimeError('Committed index/inventory mismatch')
    matched+=1
   else:
    st=os.stat(ext(Path(v['source'])))
    if st.st_size!=v['bytes'] or st.st_mtime_ns!=v['mtime_ns']:raise RuntimeError('Uncommitted source changed; no resume')
    db.execute('insert into source(path,source_path,size,mtime,expected_sha,is_sqlite,snapshot) values(?,?,?,?,?,?,?)',(key,*row));added+=1
   if v['sqlite']:sqlite_rows.append(v)
   stream_count+=1
   if stream_count%10000==0:db.commit();write('reconcile-status.json',{'state':'reconciling_inventory','at':now(),'stream_rows':stream_count,'matched':matched,'recovered':added})
 db.commit();known_snapshots={str(B/Path(v['snapshot'])).casefold():v for v in sqlite_rows};snapshots=[]
 for current,dirs,files in os.walk(ext(OLD/'sqlite-current')):
  for n in files:
   p=Path(current)/n;normal=Path(str(p)[len(P):]);rec=known_snapshots.get(str(normal).casefold());alias=short(normal);c=sqlite3.connect(alias.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=5)
   try:ok=[r[0] for r in c.execute('pragma integrity_check')]==['ok']
   finally:c.close()
   h=digest(normal)
   if not ok or (rec and h!=rec['sha256']):raise RuntimeError('Captured snapshot integrity/hash mismatch')
   snapshots.append({'path':str(normal),'bytes':os.stat(ext(normal)).st_size,'sha256':h,'integrity_ok':ok,'recorded_in_inventory':rec is not None,'short_path_verified':True})
 # Preserve and validate every recorded prior payload custody; do not overwrite it.
 versions=[]
 with (OLD/'versions.jsonl').open() as f:
  for line in f:
   v=json.loads(line)
   if digest(B/Path(v['previous_payload']))!=v['sha256']:raise RuntimeError('Prior-version custody hash mismatch')
   versions.append(v)
 if len(snapshots)>1000:raise RuntimeError('Unexpected snapshot count')
 after={n:digest(OLD/n) for n in original_files}
 if before!=after:raise RuntimeError('Preserved attempt changed during reconciliation')
 result={'state':'reconciled_ready','at':now(),'original_attempt_preserved':True,'committed_index_rows':committed,'inventory_rows':stream_count,'matched_committed':matched,'recovered_tail_rows':added,'reconciled_rows':db.execute('select count(*) from source').fetchone()[0],'snapshot_count':len(snapshots),'snapshot_checks':snapshots,'prior_version_count':len(versions),'unresolved':[],'original_hashes':before,'not_launched':True}
 write('reconciliation.json',result);write('reconcile-status.json',{k:v for k,v in result.items() if k not in ['snapshot_checks','original_hashes']});db.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  if R.exists():write('reconcile-failure.json',{'at':now(),'error_type':type(e).__name__,'message':str(e)})
  raise
