"""Bounded read-only failure localization; no source records or payload exported."""
from pathlib import Path
import sqlite3,json,datetime,os
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-20261021'
c=sqlite3.connect((R/'operator-index.sqlite3').as_uri()+'?mode=ro',uri=True,timeout=5)
try:
 rows=c.execute('select path,source_path,size,mtime,is_sqlite,snapshot from source order by rowid desc limit 3').fetchall();count=c.execute('select count(*) from source').fetchone()[0];dbs=c.execute('select count(*) from source where is_sqlite=1').fetchone()[0]
finally:c.close()
# Read only tail bytes of the PC inventory to find the last complete successful record.
p=R/'source-inventory.jsonl'
with p.open('rb') as f:
 f.seek(max(0,p.stat().st_size-16384));lines=f.read().splitlines()
tail=[]
for line in lines[-4:]:
 try:
  r=json.loads(line);tail.append({k:r.get(k) for k in ['path','source','bytes','sqlite','snapshot']})
 except ValueError:pass
# Immediate directory metadata beside the last successful inventory record; no broad walk.
last=tail[-1] if tail else None;neighbors=[]
if last:
 d=Path(last['source']).parent
 for p in d.iterdir():
  if p.is_file():
   try:
    with p.open('rb') as f:sql=f.read(16)==b'SQLite format 3\x00'
    neighbors.append({'name':p.name,'bytes':p.stat().st_size,'sqlite_header':sql})
   except OSError as e:neighbors.append({'name':p.name,'error_type':type(e).__name__})
  if len(neighbors)>=150:break
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'indexed_files':count,'indexed_sqlite':dbs,'last_index_rows':[dict(zip(['path','source','bytes','mtime_ns','sqlite','snapshot'],r)) for r in rows],'inventory_tail_metadata':tail,'last_source_directory_neighbors':neighbors,'no_job_invoked':True,'no_payload_modified':True}))
