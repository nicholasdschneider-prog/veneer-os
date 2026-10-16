$py=@'
import pathlib,json,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');out={'jobs':[],'state_candidates':[]}
for profile,ids in [('cs-tim',['b2b5b67f02c0','394f30773d39']),('ervp-manager',['d68cb0c1ae05']),('ervp-orders',['330388e25e93','305da2ff8a02']),('root',['ce772d25016e']),('accounting-migration',['2ecec57ee69b']),('ervp-dev2',['9868ee5f2643'])]:
 b=r if profile=='root' else r/'profiles'/profile
 p=b/'cron'/'jobs.json';doc=json.loads(p.read_text(encoding='utf8'));jobs=doc.get('jobs',[]) if isinstance(doc,dict) else doc
 for j in jobs:
  if j.get('id') in ids:out['jobs'].append({'profile':profile,'id':j['id'],'no_agent':j.get('no_agent'),'script_files':re.findall(r'[\w./\\-]+\.(?:py|ps1|cjs|js)',str(j.get('script'))),'prompt_file_references':re.findall(r'[\w./\\-]+\.(?:py|ps1|cjs|js|json|jsonl|db)',str(j.get('prompt')))})
 for d in ['state','scripts','workspace']:
  p=b/d
  if not p.exists():continue
  for f in p.rglob('*'):
   rel=f.relative_to(p)
   if len(rel.parts)>4 or any(v.lower() in ['node_modules','.git','venv','.venv','secrets','sessions'] for v in rel.parts):continue
   if f.is_file() and re.search(r'brent|brady|incident|dometic|martine|lippert|cursor|last.alert|processed',f.name,re.I) and not re.search(r'auth|credential|secret|token',f.name,re.I):out['state_candidates'].append({'profile':profile,'path':str(f),'bytes':f.stat().st_size,'mtime_ns':f.stat().st_mtime_ns})
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'State discovery failed'}
