$py=@'
import pathlib,json,ast,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');o={'candidates':[]}
for b in [r,r/'hermes-agent',r/'profiles'/'hermesops',r/'profiles'/'nick',pathlib.Path(r'C:\Users\nicho\.hermes')]:
 for rel in ['check_martine_reply.py','scripts/check_martine_reply.py']:
  p=b/rel
  if p.exists():
   s=p.read_text(encoding='utf8');t=ast.parse(s);o['candidates'].append({'path':str(p),'path_literals':[n.value for n in ast.walk(t) if isinstance(n,ast.Constant) and isinstance(n.value,str) and len(n.value)<300 and re.search(r'\.(?:json|jsonl|db|sqlite)$',n.value) and not re.search(r'token|secret|auth|credential',n.value,re.I)]})
p=r/'hermes-agent'/'cron'/'scheduler.py'
if p.exists():
 a=p.read_text(encoding='utf8').splitlines();o['resolution_source']=[{'line':i,'code':v[:220]} for i,v in enumerate(a,1) if re.search(r'script_path\s*=|scripts_dir\s*=|script_dir\s*=|def .*script.*path|cwd=',v) and not re.search(r'secret|credential|token',v,re.I)][:60]
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Martine path review failed'}
