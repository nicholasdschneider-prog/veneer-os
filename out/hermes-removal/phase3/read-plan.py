from pathlib import Path
import json,hashlib,os
B=Path(r'C:\Users\nicho\backups\hermes-final-20261016');D=B/'phase3-custody-20261022';X=chr(92)*2+'?'+chr(92)
def sha(p):
 h=hashlib.sha256()
 with open(X+str(p),'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
p=json.loads((D/'deletion-plan.json').read_text());assert p['state']=='ready_for_seal' and not p['deletion'];assert len(p['tasks'])==25 and len(p['startups'])==23 and len(p['wrappers'])==31
for t in p['tasks']:assert sha(Path(t['archive_path'])).upper()==t['sha256'].upper()
for f in p['startups']+p['wrappers']:assert sha(Path(f['path']))==f['sha256']==sha(B/Path(f['archive_path']))
assert all(v['hermes_owned'] for v in p['worktrees']);assert all(Path(v).exists() for v in p['keep'])
for f in p['keep_startup']:assert sha(Path(f['path']))==f['sha256']
print(json.dumps({'plan':p,'plan_sha256':sha(D/'deletion-plan.json'),'all_custody_hashes_and_live_source_hashes_match':True,'all_worktrees_hermes_owned':True,'keep_paths_and_startup_verified':True,'deletion':False}))
