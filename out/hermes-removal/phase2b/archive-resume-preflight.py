from pathlib import Path
import runpy,json,hashlib,ast,ctypes
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');p=B/'archive-quiescent-resume.py';ast.parse(p.read_text());d=runpy.run_path(str(p),run_name='operator_preflight');R=d['R'];r=json.loads((R/'reconciliation.json').read_text())
assert r['state']=='reconciled_ready' and not r['unresolved'] and r['original_attempt_preserved'];assert not (R/'status.json').exists()
failed=next(v for v in r['snapshot_checks'] if 'DawnGraphiteCache' in v['path']);source=Path(failed['path']);assert d['sha'](source)==failed['sha256']
ordinary=d['sqlcheck'](source)
old=ctypes.windll.kernel32.GetShortPathNameW
try:
 ctypes.windll.kernel32.GetShortPathNameW=lambda *args:0
 fallback=d['sqlcheck'](source)
finally:ctypes.windll.kernel32.GetShortPathNameW=old
# An isolated destination copy proves the backup API with a short path; never overwrite it.
target=R/'preflight-backup.sqlite3'
with open(d['ext'](target),'xb'):pass
src=d['sqlopen'](source);dst=d['sqlopen'](target,readonly=False)
try:src.backup(dst)
finally:dst.close();src.close()
backup=d['sqlcheck'](target)
result={'syntax_ok':True,'guard':d['guard'](),'source_sha256':d['sha'](p),'reconciled_rows':r['reconciled_rows'],'unresolved':r['unresolved'],'all66captured_snapshots_integrity_ok':all(v['integrity_ok'] for v in r['snapshot_checks']),'prior_versions_verified':r['prior_version_count'],'failed_265char_snapshot_short_alias_ok':ordinary,'forced_no_8dot3_extended_handle_copy_ok':fallback,'short_destination_backup_integrity_ok':backup,'preflight_copy':str(target),'launched':False}
assert ordinary and fallback and backup
(R/'preflight.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
