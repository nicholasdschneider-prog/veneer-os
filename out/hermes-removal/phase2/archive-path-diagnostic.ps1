$py=@'
import pathlib,os,time,json,datetime as dt,stat
root=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016\mirror');stack=[str(root)];start=time.monotonic();o={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'budget_seconds':20,'entries_checked':0,'samples':[],'enumeration_errors':[]}
while stack and time.monotonic()-start<20 and len(o['samples'])<8:
 current=stack.pop()
 try:
  with os.scandir(current) as entries:
   for e in entries:
    if time.monotonic()-start>=20:break
    o['entries_checked']+=1
    try:
     if e.is_symlink() or e.is_junction():continue
     if e.is_dir(follow_symlinks=False):stack.append(e.path);continue
     if len(e.path)<260 or pathlib.Path(e.name).suffix.lower() not in ['.py','.js','.ts','.mjs','.cjs','.map']:continue
     d={'path':str(pathlib.Path(e.path).relative_to(root)),'path_characters':len(e.path)}
     try:
      with open(e.path,'rb') as f:f.read(1)
      d['plain_read_ok']=True
     except OSError as ex:d.update(plain_read_ok=False,error_type=type(ex).__name__,winerror=getattr(ex,'winerror',None))
     try:
      with open('\\\\?\\'+e.path,'rb') as f:f.read(1)
      d['extended_read_ok']=True
     except OSError as ex:d.update(extended_read_ok=False,extended_error_type=type(ex).__name__,extended_winerror=getattr(ex,'winerror',None))
     o['samples'].append(d)
     if len(o['samples'])>=8:break
    except OSError as ex:o['enumeration_errors'].append({'error_type':type(ex).__name__,'winerror':getattr(ex,'winerror',None),'path_characters':len(e.path)})
 except OSError as ex:o['enumeration_errors'].append({'error_type':type(ex).__name__,'winerror':getattr(ex,'winerror',None),'path_characters':len(current)})
o.update(elapsed_seconds=time.monotonic()-start,scan_complete=not stack)
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Bounded archive path diagnostic failed'}
