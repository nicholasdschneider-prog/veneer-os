from pathlib import Path
import os,json,datetime,sqlite3
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-20261021';prefix=chr(92)*2+'?'+chr(92);root=R/'sqlite-current';files=[];dirs=[]
# Bounded enumeration of this run's SQLite snapshot subtree only, not another source walk.
for current,children,names in os.walk(prefix+str(root)):
 for n in names:
  p=Path(current)/n;st=p.stat();files.append((st.st_mtime_ns,p,st.st_size))
 dirs.append((os.stat(current).st_mtime_ns,str(current)))
 if len(files)>1000 or len(dirs)>10000:raise RuntimeError('Snapshot metadata bound exceeded')
rows=[]
for _,p,size in sorted(files,reverse=True)[:5]:
 r={'snapshot':str(p)[len(prefix):],'bytes':size};c=None
 try:
  c=sqlite3.connect(Path(p).as_uri()+'?mode=ro&immutable=1',uri=True,timeout=3);c.set_progress_handler(lambda:0,10000);r['quick_check_ok']=[v[0] for v in c.execute('pragma quick_check')]==['ok']
 except sqlite3.Error as e:r.update(error_type=type(e).__name__,sqlite_error_code=getattr(e,'sqlite_errorcode',None),sqlite_error_name=getattr(e,'sqlite_errorname',None),message=str(e))
 finally:
  if c:c.close()
 rows.append(r)
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'snapshot_files':len(files),'latest_snapshots':rows,'latest_snapshot_directories':[{'path':p[len(prefix):],'mtime_ns':t} for t,p in sorted(dirs,reverse=True)[:5]],'read_only':True}))
