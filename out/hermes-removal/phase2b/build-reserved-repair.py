from pathlib import Path
p=Path(__file__).parent
old=(p/'archive-quiescent-resume.py').read_text()
pre=old[:old.index('def main():')].replace("R=B/'quiescent-resume-20261021'","R=B/'quiescent-r3-20261022'")
pre+='\nS=B/\'quiescent-resume-20261021\'\n'
body=r'''
def main():
 if R.exists():raise RuntimeError('Third-attempt directory exists: inspect before replay')
 if json.loads((S/'failure.json').read_text())['message']!='Prior baseline payload hash mismatch':raise RuntimeError('Failure identity changed')
 R.mkdir();status('reserved_reconciliation_starting');guard()
 # Hash finite records before and after; source/old attempt bodies are never modified.
 record_paths=[S/n for n in ['operator-index.sqlite3','source-inventory.jsonl','versions.jsonl','failure.json','status.json']]+[B/'manifest.jsonl',B/'reconcile-20261016/manifest-addendum.jsonl']
 originals={str(f.relative_to(B)):sha(f) for f in record_paths};write('preserved-records.json',originals)
 sc=sqlite3.connect((S/'operator-index.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True);dc=sqlite3.connect(R/'operator-index.sqlite3');sc.backup(dc);sc.close();dc.close()
 db=sqlite3.connect(R/'operator-index.sqlite3');empty=hashlib.sha256(b'').hexdigest();emptyrows={v[0]:v[1] for v in db.execute('select path,sha from baseline where sha=?',(empty,))}
 import re
 reserved=re.compile(r'^(NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])(?:\..*)?$',re.I)
 scope=json.loads((B/'scope.json').read_text());corrections=[];rows=[];scanned=0
 def excluded(n,isdir):return any(fnmatch.fnmatch(n.lower(),v.lower()) for v in scope['exclude_dirs' if isdir else 'exclude_files'])
 # Same six roots and approved credential/browser exclusions. Read metadata for all other entries.
 for root,label in zip(scope['roots'],scope['labels']):
  root=pathlib.Path(root)
  for current,dirs,files in os.walk(ext(root),followlinks=False):
   base=pathlib.Path(current);dirs[:]=[n for n in dirs if not excluded(n,True) and not (base/n).is_symlink() and not (base/n).is_junction()]
   for name in files:
    if excluded(name,False) or name.endswith(('-wal','-shm','-journal')):continue
    f=base/name
    if f.is_symlink():continue
    rel=pathlib.PureWindowsPath(str(f)[len(PREFIX):]).relative_to(root);key=str(pathlib.PureWindowsPath('mirror')/label/rel);st=os.stat(ext(f));isreserved=bool(reserved.fullmatch(name.rstrip(' .')));candidate=isreserved or (key in emptyrows and st.st_size>0)
    scanned+=1
    if candidate:
     target=B/pathlib.PureWindowsPath(key);brow=db.execute('select sha from baseline where path=?',(key,)).fetchone();h=sha(f);mh=sha(target) if os.path.isfile(ext(target)) else None
     histories=[]
     for area in [OLD/'previous-payload',S/'previous-payload']:
      hist=area/label/rel
      if os.path.isfile(ext(hist)):histories.append({'path':str(hist.relative_to(B)),'sha256':sha(hist),'bytes':os.stat(ext(hist)).st_size})
     row={'path':key,'reserved_basename':isreserved,'baseline_sha256':brow[0] if brow else None,'extended_read_sha256':h,'extended_read_bytes':st.st_size,'mirror_sha256':mh,'history':histories,'source':str(root/rel)};rows.append(row)
     if brow and brow[0]!=mh:
      if mh!=h or not (isreserved or brow[0]==empty):raise RuntimeError('Unscoped baseline divergence')
      if any(v['sha256']!=mh for v in histories):raise RuntimeError('History divergence outside correction scope')
      corrections.append({**row,'supersedes_sha256':brow[0],'sha256':mh,'bytes':os.stat(ext(target)).st_size,'reason':'Reserved-device/empty-hash baseline bookkeeping correction; extended-handle evidence'})
    if scanned%10000==0:status('reserved_source_audit',files=scanned,candidates=len(rows),corrections=len(corrections))
 write('reserved-name-reconciliation.json',{'source_files_scanned':scanned,'rows':rows,'scope':scope,'excluded_credentials_not_read':True})
 with (R/'baseline-corrections.jsonl').open('x') as f:
  for row in corrections:f.write(json.dumps(row)+'\n')
 correctionsha=sha(R/'baseline-corrections.jsonl');(R/'SHA256SUMS.txt').write_text(correctionsha+'  baseline-corrections.jsonl\n')
 correct={v['path']:v for v in corrections}
 # Reconcile the stopped finite stream, including all committed and uncommitted records.
 committed=db.execute('select count(*) from source').fetchone()[0];matched=added=stream=0
 with (S/'source-inventory.jsonl').open() as f:
  for line in f:
   v=json.loads(line);key=v['path'];snapshot=str(B/pathlib.PureWindowsPath(v['snapshot'])) if v.get('snapshot') else None;values=(v['source'],v['bytes'],v['mtime_ns'],v['sha256'],int(v['sqlite']),snapshot)
   old=db.execute('select source_path,size,mtime,expected_sha,is_sqlite,snapshot from source where path=?',(key,)).fetchone()
   if old:
    if tuple(old)!=values:raise RuntimeError('Committed stream mismatch')
    matched+=1
   else:
    st=os.stat(ext(pathlib.Path(v['source'])))
    if st.st_size!=v['bytes'] or st.st_mtime_ns!=v['mtime_ns']:raise RuntimeError('Uncommitted source metadata changed')
    db.execute('insert into source(path,source_path,size,mtime,expected_sha,is_sqlite,snapshot) values(?,?,?,?,?,?,?)',(key,*values));added+=1
   stream+=1
   if stream%10000==0:db.commit();status('reconciling_stopped_stream',files=stream,matched=matched,recovered_tail=added)
 db.commit()
 versions=[json.loads(v) for v in (S/'versions.jsonl').read_text().splitlines()];known={str((B/pathlib.PureWindowsPath(v['previous_payload']))).casefold() for v in versions};unrecorded=[]
 for current,dirs,files in os.walk(ext(S/'previous-payload'),followlinks=False):
  for name in files:
   f=pathlib.Path(current)/name;normal=pathlib.Path(str(f)[len(PREFIX):])
   if str(normal).casefold() in known:continue
   rel=normal.relative_to(S/'previous-payload');key=str(pathlib.PureWindowsPath('mirror')/rel);h=sha(normal)
   if key not in correct or h!=correct[key]['sha256']:raise RuntimeError('Unjournaled history lacks exact correction')
   rec={'path':key,'previous_payload':str(normal.relative_to(B)),'sha256':h,'recovered_unjournaled_copy':True};versions.append(rec);unrecorded.append(rec)
 for v in versions:
  if sha(B/pathlib.PureWindowsPath(v['previous_payload']))!=v['sha256']:raise RuntimeError('Prior-version hash mismatch')
 with (R/'reconciled-versions.jsonl').open('x') as f:
  for v in versions:f.write(json.dumps(v)+'\n')
 snapshots=[]
 for area in [OLD/'sqlite-current',S/'sqlite-current-flat',S/'sql-short']:
  if not area.exists():continue
  for current,dirs,files in os.walk(ext(area),followlinks=False):
   for name in files:
    f=pathlib.Path(current)/name
    if header(f)!=b'SQLite format 3\x00':continue
    if not sqlcheck(f):raise RuntimeError('Captured SQLite integrity failure')
    snapshots.append({'path':str(f),'sha256':sha(f),'integrity_ok':True})
 if matched!=committed:raise RuntimeError('Committed rows not covered')
 if any(sha(B/pathlib.PureWindowsPath(k))!=v for k,v in originals.items()):raise RuntimeError('Prior records changed')
 result={'state':'reconciled_ready','at':now(),'original_attempt_preserved':True,'both_stopped_attempts_preserved':True,'committed_index_rows':committed,'matched_committed':matched,'inventory_rows':stream,'recovered_tail_rows':added,'reconciled_rows':db.execute('select count(*) from source').fetchone()[0],'prior_version_count':len(versions),'recovered_unjournaled_history':unrecorded,'snapshot_checks':snapshots,'snapshot_count':len(snapshots),'correction_count':len(corrections),'correction_sha256':correctionsha,'source_files_audited':scanned,'unresolved':[],'not_launched':True}
 write('reconciliation.json',result);db.close();status('reconciled_ready',**{k:v for k,v in result.items() if k not in ['state','at','snapshot_checks','recovered_unjournaled_history']})
if __name__=='__main__':
 try:main()
 except Exception as e:
  if R.exists():write('failure.json',{'at':now(),'error_type':type(e).__name__,'message':str(e)});(R/'controller-error.txt').write_text(traceback.format_exc());status('failed',error_type=type(e).__name__)
  raise
'''
body=body.replace(" write('reserved-name-reconciliation.json',{'source_files_scanned':scanned", " # Also audit retained mirror rows absent from the current source enumeration.\n observed={v['path'] for v in rows};empty_checked=0\n for key,prior in emptyrows.items():\n  empty_checked+=1\n  if key in observed:continue\n  target=B/pathlib.PureWindowsPath(key)\n  if not os.path.isfile(ext(target)) or os.stat(ext(target)).st_size==0:continue\n  h=sha(target);parts=pathlib.PureWindowsPath(key).parts;source=pathlib.Path(scope['roots'][scope['labels'].index(parts[1])])/pathlib.PureWindowsPath(*parts[2:]);sourcehash=sha(source) if os.path.isfile(ext(source)) else None\n  if sourcehash is not None and sourcehash!=h:raise RuntimeError('Empty-row correction source/mirror divergence')\n  histories=[]\n  for area in [OLD/'previous-payload',S/'previous-payload']:\n   hist=area/pathlib.PureWindowsPath(*parts[1:])\n   if os.path.isfile(ext(hist)):histories.append({'path':str(hist.relative_to(B)),'sha256':sha(hist),'bytes':os.stat(ext(hist)).st_size})\n  if any(v['sha256']!=h for v in histories):raise RuntimeError('Empty-row history divergence')\n  row={'path':key,'reserved_basename':bool(reserved.fullmatch(parts[-1].rstrip(' .'))),'baseline_sha256':prior,'extended_read_sha256':h,'extended_read_bytes':os.stat(ext(target)).st_size,'mirror_sha256':h,'history':histories,'source':str(source) if sourcehash else None,'source_sha256':sourcehash}\n  rows.append(row);corrections.append({**row,'supersedes_sha256':prior,'sha256':h,'bytes':row['extended_read_bytes'],'reason':'Explicit empty-hash baseline correction backed by extended-handle values'})\n"+" write('reserved-name-reconciliation.json',{'source_files_scanned':scanned").replace("'excluded_credentials_not_read':True","'excluded_credentials_not_read':True,'baseline_empty_rows_audited':empty_checked")
(p/'archive-reserved-reconcile.py').write_text(pre+body)
