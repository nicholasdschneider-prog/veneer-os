$ErrorActionPreference='Stop'
$py=@'
import json,pathlib,hashlib,sqlite3,zipfile,re,collections
base=pathlib.Path(r'C:\Users\nicho\backups\hermes-retirement-20261013')
out={'artifacts':[]}
for p in base.iterdir():
 if p.is_file():
  d={'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  if p.name=='nick-work-kanban.snapshot.db':
   c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True)
   d['integrity_check']=[r[0] for r in c.execute('pragma integrity_check')]
   tables=[r[0] for r in c.execute("select name from sqlite_master where type='table'")]
   d['table_count']=len(tables)
   if 'tasks' in tables:d['task_count']=c.execute('select count(*) from tasks').fetchone()[0]
   c.close()
  if p.suffix=='.zip':
   with zipfile.ZipFile(p) as z:
    bad=z.testzip(); d['crc_ok']=bad is None;d['entry_count']=len(z.infolist());d['uncompressed_bytes']=sum(i.file_size for i in z.infolist())
  if p.name=='ledger-backup-verification.json':
   j=json.loads(p.read_text(encoding='utf-8-sig'));d['verification_keys']=list(j)
   d['verification_metadata']={k:v for k,v in j.items() if re.search(r'count|sha256|integrity|backup|snapshot|size|bytes|verified|created|timestamp',k,re.I) and isinstance(v,(str,int,float,bool,type(None))) and not re.search(r'token|secret|password',k,re.I)}
  out['artifacts'].append(d)
logs=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\backup-logs\brain-vault')
out['recent_logs']=[]
for p in sorted(logs.glob('*'),key=lambda p:p.stat().st_mtime,reverse=True)[:4]:
 text=p.read_text(errors='replace');lines=text.splitlines();signals=[]
 for n,line in enumerate(lines,1):
  labels=[label for label,pattern in {'permission_denied':r'permission denied|access.*denied','ssh_failure':r'host key verification failed|connection refused|connection timed out|could not resolve','disk_full':r'not enough space|no space left','path_missing':r'cannot find|not found|does not exist','powershell_error':r'Exception|CategoryInfo|FullyQualifiedErrorId|ERROR|failed','zip_problem':r'archive.*error|Compress-Archive.*error','success':r'success|completed|exit.code.?0'}.items() if re.search(pattern,line,re.I)]
  # Labels and error type only; never emit arbitrary log lines or message bodies.
  if labels:signals.append({'line':n,'labels':labels,'error_types':re.findall(r'\b\w+(?:Exception|Error)\b',line)[:5]})
 out['recent_logs'].append({'path':str(p),'bytes':p.stat().st_size,'line_count':len(lines),'signals':signals[-30:]})
out['snapshots']=[{'path':str(p),'bytes':p.stat().st_size,'mtime':p.stat().st_mtime} for p in pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\backup-versions\brain-vault').glob('*') if p.is_file()]
script=pathlib.Path(r'C:\Users\nicho\HermesBrainOps\Sync-HermesBrain.ps1').read_text(encoding='utf-8-sig')
out['backup_logic']={'script':str(pathlib.Path(r'C:\Users\nicho\HermesBrainOps\Sync-HermesBrain.ps1')),'line_count':len(script.splitlines()),'remote_variable_names':sorted(set(re.findall(r'\$Remote\w+',script))),'exclusion_literals':re.findall(r'(?i)(?:exclude|skip)[^\r\n]{0,150}',script)[:12]}
print(json.dumps(out))
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))"
if($LASTEXITCODE -ne 0){throw 'Read-only Python verification failed'}
