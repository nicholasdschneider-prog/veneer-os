$ErrorActionPreference='Stop'
$py=@'
import pathlib,json,re,sqlite3
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\backup-logs\brain-vault\brain-sync-20261016T072023.log')
s=p.read_text(errors='replace')
patterns=[r'Cannot overwrite variable \w+ because it is read-only or constant',r'Cannot bind (?:argument|parameter)[^\r\n:]{0,100}',r'Cannot find (?:path|drive|command)',r'Could not find a part of the path',r'Permission denied',r'Host key verification failed',r'Connection (?:refused|timed out)',r'No such file or directory',r'The term[^\r\n]{0,30}is not recognized',r'not recognized as[^\r\n]{0,40}',r'not a git repository',r'Cannot process argument transformation',r'Cannot validate argument',r'file is being used by another process',r'not enough space',r'ERROR\s*[:=]\s*[0-9]+',r'exit(?:ed)?(?: code| status)?[=: ]+\d+',r'Access is denied',r'parameter cannot be found',r'ErrorActionPreference',r'PropertyNotFoundException',r'TermNotFound',r'ParameterBinding\w*',r'SSH[^\r\n]{0,15}failed',r'SCP[^\r\n]{0,15}failed',r'git[^\r\n]{0,15}failed']
out={'log':str(p),'recognized_diagnostics':sorted(set(m.group(0) for pattern in patterns for m in re.finditer(pattern,s,re.I))),'keyword_presence':{k:bool(re.search(k,s,re.I)) for k in ['git','ssh','scp','zip','snapshot','sync','remote','timeout','denied','failed','fatal','exception','exit','readonly','constant','bind','argument','connect','hostname','port','parse']}}
j=json.loads(pathlib.Path(r'C:\Users\nicho\backups\hermes-retirement-20261013\ledger-backup-verification.json').read_text(encoding='utf-8-sig'))
allowed=set('snapshot sync remote export exports import imports failed failure error warning start started complete completed successful success unavailable connection timeout timed out refused command result code status exit returned retry attempt attempts local vault backup backups skipped missing required path file directory host port network unreachable operation upload download transport authentication permission denied cannot find not found python subprocess process stopped closed response invalid source destination at on to from for and the is was are with without read write create created resolved service refused timedout installed reachable ready clean ok configured enabled available exists present runtime helper workspace script stale current fresh update old latest prior previous canonical overwritten healthy accessible accessible helper exporter unavailable valid valid inaccessible newer older protected obsolete failed skipped aborted refused refresh refreshed generated generation'.split())
out['log_sanitized_words']=[' '.join(t if t.lower() in allowed else '[redacted]' for t in re.findall(r'[A-Za-z_][A-Za-z_0-9-]*',line)) for line in s.splitlines()]
out['original_verification']={k:j.get(k) for k in ['captured_utc','integrity_check','task_counts']}
c=sqlite3.connect(pathlib.Path(r'C:\Users\nicho\backups\hermes-retirement-20261013\nick-work-kanban.snapshot.db').as_uri()+'?mode=ro&immutable=1',uri=True)
out['snapshot_status_counts']=dict(c.execute('select status,count(*) from tasks group by status'));c.close()
script=pathlib.Path(r'C:\Users\nicho\HermesBrainOps\Sync-HermesBrain.ps1').read_text(encoding='utf-8-sig')
out['remote_config']={}
for name in ['RemoteHost','RemoteWorkspace','RemoteBackupRoot']:
 m=re.search(r'\$'+name+r'\s*=\s*[\x22\x27]([^\x22\x27]+)',script)
 if m:out['remote_config'][name]=m.group(1)
out['projection_scope_keywords']={k:bool(re.search(k,script,re.I)) for k in ['kanban.db','sqlite','state.db','session','token','Compress-Archive','Push-Location','git push','scp','ssh']}
print(json.dumps(out))
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$encoded'))"
if($LASTEXITCODE -ne 0){throw 'Read-only backup diagnostic failed'}
