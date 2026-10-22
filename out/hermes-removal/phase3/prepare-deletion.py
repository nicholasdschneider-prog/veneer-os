from pathlib import Path,PureWindowsPath
import os,json,hashlib,subprocess,datetime,sqlite3,shutil,re
H=Path(r'C:\Users\nicho');B=H/'backups/hermes-final-20261016';R=B/'quiescent-r3-20261022';D=B/'phase3-custody-20261022';X=chr(92)*2+'?'+chr(92)
def ext(p):return str(p) if str(p).startswith(X) else X+str(p)
def sha(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def copynew(a,b):
 os.makedirs(ext(b.parent),exist_ok=True)
 with open(ext(a),'rb') as src,open(ext(b),'xb') as dest:shutil.copyfileobj(src,dest)
 assert sha(a)==sha(b)
def write(n,v):(D/n).write_text(json.dumps(v,indent=2)+'\n')
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def main():
 assert not D.exists(),'Custody exists: inspect journal before replay';D.mkdir();write('status.json',{'state':'preparing','at':now(),'deletion':False})
 v=json.loads((R/'verification.json').read_text());review=json.loads((R/'independent-review.json').read_text());assert v['state']=='refresh_verified_pending_operator_seal' and review['independent_archive_review_passed']
 scope=json.loads((B/'scope.json').read_text());roots=[];links=[];wrappers=[];c=sqlite3.connect((R/'operator-index.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True)
 for root,label in zip(scope['roots'],scope['labels']):
  root=Path(root);rec={'path':str(root),'label':label,'bytes':0,'files':0,'directories':0,'reparse_points':[]};assert root.is_dir() and not root.is_symlink() and not root.is_junction()
  for current,dirs,files in os.walk(ext(root),followlinks=False):
   base=Path(current);kept=[]
   for name in dirs:
    f=base/name
    if f.is_symlink() or f.is_junction():
     row={'path':str(f)[len(X):],'target':os.readlink(ext(f)),'kind':'directory'};rec['reparse_points'].append(row);links.append(row)
    else:kept.append(name);rec['directories']+=1
   dirs[:]=kept
   for name in files:
    f=base/name
    if f.is_symlink():
     row={'path':str(f)[len(X):],'target':os.readlink(ext(f)),'kind':'file'};links.append(row);rec['reparse_points'].append(row);continue
    rec['bytes']+=os.stat(ext(f)).st_size;rec['files']+=1
    rel=PureWindowsPath(str(f)[len(X):]).relative_to(root);parts=rel.parts
    if label=='local-hermes' and re.search(r'\.(vbs|cmd)(?:\..*)?$',name,re.I) and (parts[0].lower()=='services' or (len(parts)>=4 and parts[0].lower()=='profiles' and parts[2].lower()=='scripts')):
     key=str(PureWindowsPath('mirror')/label/rel);expected=c.execute('select expected_sha from source where path=?',(key,)).fetchone()
     if not expected:raise RuntimeError('Wrapper absent from sealed source index: '+key)
     h=sha(f);assert h==expected[0]==sha(B/PureWindowsPath(key)),'Wrapper recovery mismatch'
     wrappers.append({'path':str(f)[len(X):],'bytes':os.stat(ext(f)).st_size,'sha256':h,'archive_path':key,'kind':'wrapper'})
   if rec['files'] and rec['files']%10000<100:write('status.json',{'state':'measuring','root':label,'files':rec['files'],'at':now(),'deletion':False})
  roots.append(rec)
 c.close()
 # Classify .worktrees ownership through retained gitdir metadata, never execute Git or a job.
 worktrees=[]
 for child in (H/'.worktrees').iterdir():
  if not child.is_dir() or child.is_symlink() or child.is_junction():continue
  git=child/'.git';gitdir=git.read_text().strip() if git.is_file() else None
  owned=bool(gitdir and gitdir.lower().startswith('gitdir:') and 'hermes' in gitdir.lower())
  worktrees.append({'path':str(child),'gitdir':gitdir,'hermes_owned':owned})
 if not worktrees or not all(x['hermes_owned'] for x in worktrees):raise RuntimeError('Unresolved worktree ownership; no deletion')
 # Export only exact Hermes tasks; retain the independent outside-Hermes DometicInventory task.
 ps=r'''$ErrorActionPreference='Stop';$d='C:\Users\nicho\backups\hermes-final-20261016\phase3-custody-20261022';$rows=@();foreach($t in @(Get-ScheduledTask|Where-Object{$_.TaskName -match 'Hermes|^ERVP_Orders_Bot_|^OrderOps_Order_Completion_Mirror$|^ERVP_Dometic_Safe_Poller$'})){if($t.Settings.Enabled){throw 'Enabled retirement task'};$name=$t.TaskName;$xml=Export-ScheduledTask -TaskName $name -TaskPath $t.TaskPath;$p=Join-Path $d ('task-'+$rows.Count+'.xml');if(Test-Path $p){throw 'XML exists'};[IO.File]::WriteAllText($p,$xml,[Text.UTF8Encoding]::new($false));$rows+=@{name=$name;task_path=$t.TaskPath;archive_path=$p;sha256=(Get-FileHash $p).Hash;bytes=(Get-Item $p).Length;kind='task'}};$rows|ConvertTo-Json -Depth 5'''
 out=subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',ps],capture_output=True,text=True,timeout=90);assert out.returncode==0,out.stderr;tasks=json.loads(out.stdout.lstrip('\ufeff'));assert len(tasks)==25
 startups=[];keepstart=[]
 for folder in [Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup',Path(os.environ['ProgramData'])/'Microsoft/Windows/Start Menu/Programs/StartUp']:
  for f in folder.iterdir():
   if not f.is_file():continue
   if 'hermes' not in f.name.lower():keepstart.append({'path':str(f),'sha256':sha(f)});continue
   dest=D/'startup'/f.name;copynew(f,dest);startups.append({'path':str(f),'bytes':os.stat(ext(f)).st_size,'sha256':sha(f),'archive_path':str(dest.relative_to(B)),'kind':'startup'})
 assert len(startups)==23
 keep=[str(H/x) for x in ['backups','ervp-vendor-automation','orderops-src']]+[r'C:\Python314',str(H/'AppData/Roaming/uv')];assert all(Path(x).exists() for x in keep)
 plan={'at':now(),'state':'ready_for_seal','deletion':False,'roots':roots,'tasks':tasks,'startups':startups,'wrappers':wrappers,'worktrees':worktrees,'reparse_points':links,'keep':keep,'keep_startup':keepstart,'keep_tasks':['ERVP_Dometic_Inventory'],'free_bytes_before':shutil.disk_usage(H).free,'manifest_sha256':v['manifest_sha256'],'order':['tasks/startup/wrappers','worktrees','legacy-data','dot-hermes','brain-ops','local-hermes','obsidian-brain']}
 write('deletion-plan.json',plan);mh=sha(D/'deletion-plan.json');(D/'SHA256SUMS.txt').write_text(mh+'  deletion-plan.json\n'+''.join(sha(Path(t['archive_path']))+'  '+Path(t['archive_path']).name+'\n' for t in tasks));write('status.json',{'state':'ready_for_seal','at':now(),'plan_sha256':mh,'deletion':False,'tasks':len(tasks),'startups':len(startups),'wrappers':len(wrappers),'roots':roots,'free_bytes_before':plan['free_bytes_before']})
if __name__=='__main__':
 try:main()
 except Exception as e:
  if D.exists():write('failure.json',{'at':now(),'error':type(e).__name__,'message':str(e)});write('status.json',{'state':'failed','at':now(),'deletion':False})
  raise
