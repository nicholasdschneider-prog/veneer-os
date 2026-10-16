$ErrorActionPreference='Stop'
$py=@'
import os,pathlib,json,re
roots=[r'C:\Users\nicho\AppData\Local\hermes',r'C:\Users\nicho\.hermes',r'C:\Users\nicho\HermesBrainOps',r'C:\Users\nicho\HermesLegacyData',r'C:\Users\nicho\ObsidianVaults\Hermes Brain',r'C:\Users\nicho\.worktrees']
out=[]
for root in roots:
 d={'path':root,'exists':os.path.exists(root),'bytes':0,'files':0,'directories':0,'reparse_points_skipped':0,'reparse_points':[],'errors':0,'archival_cron':[]};stack=[root]
 while stack:
  path=stack.pop()
  try:
   with os.scandir(path) as entries:
    for e in entries:
     try:
      if e.is_symlink() or e.is_junction():
       d['reparse_points_skipped']+=1;d['reparse_points'].append({'path':e.path,'target':os.readlink(e.path)});continue
      if e.is_dir(follow_symlinks=False):d['directories']+=1;stack.append(e.path)
      elif e.is_file(follow_symlinks=False):
       st=e.stat(follow_symlinks=False);d['files']+=1;d['bytes']+=st.st_size
       if root==roots[0] and e.name=='jobs.json' and pathlib.Path(e.path).parent.name=='cron':
        p=pathlib.Path(e.path);direct=p==pathlib.Path(root)/'cron'/'jobs.json' or (p.parent.parent.parent==pathlib.Path(root)/'profiles')
        if not direct:
         try:
          j=json.loads(p.read_text(encoding='utf-8-sig'));jobs=j.get('jobs',[]) if isinstance(j,dict) else j
          d['archival_cron'].append({'path':str(p),'jobs':[{'id':v.get('id'),'name':v.get('name'),'enabled':v.get('enabled')} for v in jobs]})
         except Exception:d['errors']+=1
     except OSError:d['errors']+=1
  except OSError:d['errors']+=1
 out.append(d)
print(json.dumps(out))
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))"
if($LASTEXITCODE -ne 0){throw 'Read-only storage enumeration failed'}
