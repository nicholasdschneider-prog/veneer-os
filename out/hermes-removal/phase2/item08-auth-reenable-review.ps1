$py=@'
import pathlib,json,re,ast
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');p=r/'profiles'/'ervp-manager'/'cron'/'jobs.json';d=json.loads(p.read_text(encoding='utf8'));js=d.get('jobs',[]) if isinstance(d,dict) else d;j=next(v for v in js if v['id']=='89de9427e76b');o={'job_metadata':{k:j.get(k) for k in ['id','enabled','state','paused_at','paused_reason','last_run_at','next_run_at','last_status','failure_streak']},'script_files':re.findall(r'[\w./\\-]+\.(?:py|ps1|cmd)',str(j.get('script'))),'pause_source':[],'profile_script_references':[]}
p=r/'hermes-agent'/'cron'/'jobs.py';a=p.read_text(encoding='utf8').splitlines()
for i,v in enumerate(a):
 if re.search(r'^def (pause_job|resume_job|disable_job|update_job)|enabled.*state|state.*enabled',v):o['pause_source'].append({'line':i+1,'code':v[:240]})
t=ast.parse('\n'.join(a))
for n in t.body:
 if isinstance(n,ast.FunctionDef) and n.name in ['pause_job','disable_job']:
  o['pause_source'].append({'function':n.name,'code':'\n'.join(a[n.lineno-1:n.end_lineno])[:10000]})
p=r/'profiles'/'ervp-manager'/'scripts'
for f in p.iterdir():
 if f.suffix.lower() not in ['.py','.ps1','.js','.cjs','.cmd']:continue
 try:s=f.read_text(encoding='utf8',errors='replace')
 except OSError:continue
 if '89de9427e76b' in s:o['profile_script_references'].append({'path':str(f),'lines':[i for i,v in enumerate(s.splitlines(),1) if '89de9427e76b' in v]})
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Auth reenable review failed'}
