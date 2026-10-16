$py=@'
import pathlib,os,re,json,datetime as dt,sqlite3
base=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');out={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'references':[],'scanned_files':0,'errors':[]}
roots=[base,pathlib.Path(r'C:\Users\nicho\.hermes'),pathlib.Path(r'C:\Users\nicho\HermesBrainOps'),pathlib.Path(r'C:\Users\nicho\HermesLegacyData'),pathlib.Path(r'C:\Users\nicho\ObsidianVaults\Hermes Brain'),pathlib.Path(r'C:\Users\nicho\.worktrees')]
skip={'node_modules','venv','.venv','.git','__pycache__','.cache','cache','caches','backups','backup-versions','state-snapshots','logs','sessions','secrets','credentials','auth','tokens','browser','browsers','downloads','dist','build'}
for root in roots:
 for current,dirs,files in os.walk(root,followlinks=False):
  b=pathlib.Path(current);dirs[:]=[n for n in dirs if n.lower() not in skip and not (b/n).is_symlink() and not (b/n).is_junction()]
  for name in files:
   p=b/name
   if p.suffix.lower() not in {'.py','.js','.cjs','.mjs','.ts','.ps1','.cmd','.vbs','.md'} and name!='jobs.json':continue
   if re.search('credential|secret|token|cookie|auth|\.env|private.key|password',name,re.I) or p.is_symlink():continue
   try:
    if p.stat().st_size>2*1024*1024:continue
    s=p.read_text(encoding='utf8',errors='replace');out['scanned_files']+=1
    terms=[t for t in ['shadow-latest.json','lippert-final-tracking-owner','owner.sqlite3'] if t.lower() in s.lower()]
    if terms:out['references'].append({'path':str(p),'terms':terms,'lines':{t:[i for i,v in enumerate(s.splitlines(),1) if t.lower() in v.lower()] for t in terms}})
   except OSError:out['errors'].append(str(p))
p=base/'profiles'/'ervp-dev2'/'workspace'/'lippert-final-tracking-owner'/'reports'/'shadow-latest.json';out['report']={'path':str(p),'exists':p.exists()}
if p.exists():
 j=json.loads(p.read_text(encoding='utf8'));out['report'].update(bytes=p.stat().st_size,mtime_ns=p.stat().st_mtime_ns,top_fields={k:({'count':len(v)} if isinstance(v,(list,dict)) else v if isinstance(v,(bool,int,float)) or k in ['mode','status','run_id','started_at','finished_at','generated_at'] else {'type':type(v).__name__}) for k,v in j.items() if not re.search('token|secret|credential|auth',k,re.I)})
p=base/'profiles'/'ervp-dev2'/'workspace'/'lippert-final-tracking-owner'/'state'/'owner.sqlite3';out['owner_db']={'path':str(p),'exists':p.exists()}
if p.exists():
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);out['owner_db']['schema']={r[0]:[v[1] for v in c.execute('pragma table_info("'+r[0]+'")')] for r in c.execute("select name from sqlite_master where type='table'")};c.close()
# Root job workdir/script location metadata only, never invocation.
p=base/'cron'/'jobs.json';d=json.loads(p.read_text(encoding='utf8'));jobs=d.get('jobs',[]) if isinstance(d,dict) else d;j=next(v for v in jobs if v.get('id')=='ce772d25016e');out['martine_definition']={'workdir':j.get('workdir'),'script_file_names':re.findall(r'[\w./\\-]+\.py',str(j.get('script'))),'candidate_locations':[str(x) for x in roots if (x/'scripts'/'check_martine_reply.py').exists()]}
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$result=(& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))")|ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw 'Static shadow consumer audit failed'}
$tasks=@(Get-ScheduledTask|Where-Object {$_.Settings.Enabled -and (@($_.Actions|Where-Object {$_.Arguments -match 'shadow-latest.json|lippert-final-tracking-owner|owner.sqlite3'}).Count -gt 0)}|ForEach-Object {@{name=$_.TaskName;state=[string]$_.State}})
[pscustomobject]@{audit=$result;enabled_task_output_references=$tasks}|ConvertTo-Json -Depth 15
