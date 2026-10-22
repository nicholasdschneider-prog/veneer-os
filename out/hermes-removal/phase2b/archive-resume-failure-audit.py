from pathlib import Path
import sqlite3,json,os,hashlib,datetime
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-resume-20261021';P=chr(92)*2+'?'+chr(92)
def sha(p):
 h=hashlib.sha256()
 with open(P+str(p),'rb') as f:
  for v in iter(lambda:f.read(1024*1024),b''):h.update(v)
 return h.hexdigest()
c=sqlite3.connect((R/'operator-index.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True)
versions=[json.loads(v) for v in (R/'versions.jsonl').read_text().splitlines()];known={str(B/Path(v['previous_payload'])).casefold() for v in versions};orphans=[];history_count=0
for current,dirs,files in os.walk(P+str(R/'previous-payload')):
 for name in files:
  f=Path(current)/name;p=Path(str(f)[len(P):]);history_count+=1
  if str(p).casefold() in known:continue
  rel=p.relative_to(R/'previous-payload');key=str(Path('mirror')/rel);row=c.execute('select sha from baseline where path=?',(key,)).fetchone();target=B/Path(key);st=p.stat();srcs=json.loads((B/'scope.json').read_text());parts=rel.parts;src=Path(srcs['roots'][srcs['labels'].index(parts[0])])/Path(*parts[1:]);h=sha(p);th=sha(target)
  orphans.append({'path':key,'history_bytes':os.stat(P+str(p)).st_size,'normal_stat_bytes':st.st_size,'history_sha256':h,'baseline_sha256':row[0] if row else None,'current_mirror_sha256':th,'history_matches_current_mirror':h==th,'source_sha256':sha(src),'source_bytes':os.stat(P+str(src)).st_size})
 if history_count>2000:raise RuntimeError('Bound exceeded')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'failure':json.loads((R/'failure.json').read_text()),'committed_source_rows':c.execute('select count(*) from source').fetchone()[0],'recorded_versions':len(versions),'resume_history_files':history_count,'unrecorded_preserved_history':orphans,'traceback':(R/'controller-error.txt').read_text(),'read_only':True,'relaunch':False,'deletion':False};c.close();print(json.dumps(result))
