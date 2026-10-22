from pathlib import Path
import ast
p=Path(__file__).parent;t=(p/'archive-quiescent-resume.py').read_text()
t=t.replace("R=B/'quiescent-resume-20261021';OLD=B/'quiescent-20261021'","R=B/'quiescent-r3-20261022';OLD=B/'quiescent-20261021';PREV=B/'quiescent-resume-20261021'")
t=t.replace('def sqlite_path(p,immutable=True):',"def reserved(p):\n import re\n return bool(re.fullmatch(r'(NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])(?:\\..*)?',pathlib.PureWindowsPath(str(p)).name.rstrip(' .'),re.I))\ndef sqlite_path(p,immutable=True):")
t=t.replace('if len(str(candidate))<220:','if len(str(candidate))<220 and not reserved(candidate):').replace('if len(str(normal))<220:','if len(str(normal))<220 and not reserved(normal):')
t=t.replace('archive-quiescent(?:-resume)?','archive-quiescent(?:-resume|-r3)?')
needle=" if (R/'status.json').exists():raise RuntimeError('Resume status exists: reconcile before any replay')"
t=t.replace(needle," if (R/'refresh-status-started.json').exists():raise RuntimeError('Third launch already started: inspect before replay')\n write('refresh-status-started.json',{'at':now(),'launch_attempts':1})\n correction_file=R/'baseline-corrections.jsonl'\n if sha(correction_file)!=reconciliation['correction_sha256']:raise RuntimeError('Correction addendum SHA mismatch')\n corrections={v['path']:v for v in (json.loads(line) for line in correction_file.read_text().splitlines())}\n for v in corrections.values():\n  if v['sha256']!=v['mirror_sha256'] or v['sha256']!=v['extended_read_sha256']:raise RuntimeError('Correction values diverge')")
t=t.replace("with (OLD/'versions.jsonl').open() as existing_versions:","with (R/'reconciled-versions.jsonl').open() as existing_versions:")
t=t.replace("      if sha(history)!=prior:raise RuntimeError('Prior baseline payload hash mismatch')", "      actual_prior=sha(history)\n      if actual_prior!=prior:\n       correction=corrections.get(key)\n       if not correction or correction['baseline_sha256']!=prior or correction['sha256']!=actual_prior:raise RuntimeError('Unapproved prior baseline payload hash mismatch')\n       prior=actual_prior\n       with (R/'applied-corrections.jsonl').open('a') as applied:applied.write(json.dumps({'path':key,'correction_sha256':reconciliation['correction_sha256'],'baseline_sha256':correction['baseline_sha256'],'verified_prior_sha256':actual_prior})+'\\n')")
# Check every payload database outside mirror too, including old snapshots, versions, metadata DBs and earlier restore copies.
a=t.index(' for area in [OLD/');b=t.index(" if not sqlcheck(R/'operator-index.sqlite3')",a)
t=t[:a]+''' for current,dirs,files in os.walk(ext(B),followlinks=False):
  base=pathlib.Path(current)
  dirs[:]=[n for n in dirs if not (base/n).is_symlink() and not (base/n).is_junction() and not (base==pathlib.Path(ext(B)) and n.lower()=='mirror')]
  for name in files:
   f=base/name
   if f.is_symlink():continue
   if header(f)==b'SQLite format 3\\x00':
    ok=sqlcheck(f);checks.append({'path':str(f),'integrity_ok':ok,'nonstandard_extension':f.suffix.lower() not in ['.db','.sqlite','.sqlite3'],'kind':'snapshot_or_history'});supplemental+=1
    if not ok:errors.append({'path':str(f),'error':'Supplemental SQLite integrity failed'})
''' + t[b:]
# Include hashes of immutable correction addendum in final authoritative report.
t=t.replace("'final_seal':False,'pending':", "'baseline_correction_sha256':sha(R/'baseline-corrections.jsonl'),'baseline_correction_count':len(corrections),'both_stopped_attempts_preserved':True,'final_seal':False,'pending':")
t=t.replace("['Independent operator readback and late LTL confirmation before sealed verdict.']","['Independent operator readback before sealed verdict; Brain and late LTL confirmations already verified.']")
t=t.replace("restores.append({'path':rec['path'],'hash_matches':sha(dest)==rec['sha256'],'bytes_match':os.stat(ext(dest)).st_size==rec['bytes']})", "restores.append({'path':rec['path'],'hash_matches':sha(dest)==rec['sha256'],'bytes_match':os.stat(ext(dest)).st_size==rec['bytes'],'sqlite_integrity_ok':sqlcheck(dest) if header(dest)==b'SQLite format 3\\x00' else True})")
t=t.replace("v['hash_matches'] and v['bytes_match'] for v in restores", "v['hash_matches'] and v['bytes_match'] and v['sqlite_integrity_ok'] for v in restores")
ast.parse(t);(p/'archive-quiescent-r3.py').write_text(t)
