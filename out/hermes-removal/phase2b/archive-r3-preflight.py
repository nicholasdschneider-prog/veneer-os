from pathlib import Path
import runpy,json,sqlite3,hashlib,ast
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');R=B/'quiescent-r3-20261022';source=B/'archive-quiescent-r3.py';d=runpy.run_path(str(source),run_name='operator_preflight');sha=d['sha'];ext=d['ext'];r=json.loads((R/'reconciliation.json').read_text());rows=[json.loads(x) for x in (R/'baseline-corrections.jsonl').read_text().splitlines()];corr={v['path']:v for v in rows}
assert r['state']=='reconciled_ready' and not r['unresolved'] and r['both_stopped_attempts_preserved'];assert r['committed_index_rows']==r['matched_committed']==2380000 and r['reconciled_rows']==2386571 and r['recovered_tail_rows']==6571 and r['prior_version_count']==372 and r['snapshot_count']==259
assert len(rows)==1 and sha(R/'baseline-corrections.jsonl')==r['correction_sha256'];row=rows[0];assert row['path']==r'mirror\local-hermes\profiles\ervp-orders\workspace\NUL';assert row['bytes']==54
assert row['sha256']==sha(Path(row['source']))==sha(B/Path(row['path']))==sha(B/Path(row['history'][0]['path']))
assert d['validate_prior'](row['path'],row['baseline_sha256'],row['sha256'],corr)==row['sha256']
negative=0
for key,baseline,actual in [('mirror\\other',row['baseline_sha256'],row['sha256']),(row['path'],'wrong-baseline',row['sha256']),(row['path'],row['baseline_sha256'],'wrong-actual')]:
 try:d['validate_prior'](key,baseline,actual,corr)
 except RuntimeError:negative+=1
assert negative==3
assert all(d['reserved'](v) for v in ['NUL','con.txt','COM9.db','LPT1','PRN.foo','AUX']);assert not d['reserved']('console.txt')
originals=json.loads((R/'preserved-records.json').read_text());assert all(sha(B/Path(k))==v for k,v in originals.items())
c=sqlite3.connect((R/'operator-index.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True);assert c.execute('select count(*) from source').fetchone()[0]==2386571;c.close()
assert all(v['integrity_ok'] for v in r['snapshot_checks']);assert not (R/'refresh-status-started.json').exists()
headers=[n.value for n in ast.walk(ast.parse(source.read_text())) if isinstance(n,ast.Constant) and isinstance(n.value,bytes) and n.value];assert all(len(v)==16 and v[-1]==0 for v in headers)
# Recheck one exact path-access regression using the original snapshot, without modifying it.
regression=next(Path(v['path']) for v in r['snapshot_checks'] if 'DawnGraphiteCache' in v['path']);assert d['sqlcheck'](regression)
result={'source_sha256':sha(source),'reconciliation_rows':2386571,'correction_count':1,'correction_sha256':r['correction_sha256'],'negative_unapproved_mismatch_checks':negative,'original_records_preserved':True,'snapshot_checks_all259_ok':True,'reserved_source_mirror_history54bytes_sha_match':True,'path_access_regression_integrity_ok':True,'sqlite_header_detection_ok':True,'guard':d['guard'](),'launched':False}
with (R/'refresh-preflight.json').open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
