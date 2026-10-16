$py=@'
import pathlib,json,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');b=r/'profiles'/'cs-tim';o={'source_lines':[],'top_files':[],'state_files':[]}
for name in ['watch_brent_orderops_reply.py','orderops_monitor_brady_reply.py']:
 p=b/'scripts'/name
 a=p.read_text(encoding='utf8').splitlines()
 o['source_lines'].append({'path':str(p),'matches':[{'line':i,'code':v} for i,v in enumerate(a,1) if re.search(r'state|cursor|last.alert|\.json|fingerprint',v,re.I) and not re.search(r'token|secret|credential|auth|response|message|body',v,re.I)]})
for p in [b,b/'state',b/'sessions']:
 if p.exists():
  for f in p.iterdir():
   if f.is_file():o['top_files'].append({'path':str(f),'bytes':f.stat().st_size})
p=r/'hermes-agent'/'gateway'/'status.py'
if p.exists():
 o['status_paths']=[{'line':i,'code':v} for i,v in enumerate(p.read_text(encoding='utf8').splitlines(),1) if re.search(r'active_agent|active_session|runtime.status|runtime_status|\.json|\.pid',v) and not re.search(r'token|secret|credential',v,re.I)][:90]
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'State review failed'}
