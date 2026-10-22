from pathlib import Path
import os,json,hashlib,datetime
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016')
def sha(p):
 h=hashlib.sha256()
 with open('\\\\?\\'+str(p),'rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 return h.hexdigest()
plan=json.loads((B/'phase3-custody-20261022/deletion-plan.json').read_text())
report=json.loads((B/'phase3-delete-20261022/verification.json').read_text())
seal=json.loads((B/'phase3-sealed-verdict-20261022.json').read_text())
roots=[{'path':r['path'],'exists':os.path.lexists('\\\\?\\'+r['path'])} for r in plan['roots']]
kept=[{'path':p,'exists':Path(p).exists()} for p in plan['keep']]
startup=[{'path':r['path'],'hash_unchanged':sha(Path(r['path']))==r['sha256']} for r in plan['keep_startup']]
external=Path(r'C:\Users\nicho\elkhart-orderops-fix\node_modules')
manifest_sha=sha(B/'quiescent-r3-20261022/manifest-current.jsonl')
addendum_sha=sha(B/'quiescent-r3-20261022/manifest-addendum.jsonl')
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'controller_report':report,'independent':{'roots':roots,'keep_paths':kept,'keep_startup':startup,'external_reparse_target_exists':external.exists(),'standalone_ltl_helper_retained':Path(r'C:\Users\nicho\ltl-tracking-cleanup.py').exists(),'archive_exists':B.exists(),'manifest_sha256':manifest_sha,'manifest_matches_seal':manifest_sha==seal['manifest_sha256'],'manifest_addendum_sha256':addendum_sha,'seal_sha256':sha(B/'phase3-sealed-verdict-20261022.json'),'plan_sha256':sha(B/'phase3-custody-20261022/deletion-plan.json'),'both_failed_attempts_preserved':all((B/x).exists() for x in ['quiescent-20261021','quiescent-resume-20261021'])}}))
