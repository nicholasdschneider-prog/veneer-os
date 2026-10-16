$py=@'
import pathlib,json,ast,re
paths=[r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-dev2\scripts\lippert_final_tracking_shadow.py',r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-dev2\workspace\lippert-final-tracking-owner\lippert_final_tracking.py',r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\scripts\inventory-sync-incident-router-wrapper.py']
out=[]
for name in paths:
 p=pathlib.Path(name);d={'path':str(p),'exists':p.exists()}
 if p.exists():
  s=p.read_text(encoding='utf8',errors='replace');tree=ast.parse(s)
  d['path_literals']=list(dict.fromkeys(n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and len(n.value)<400 and re.search(r'\.(?:json|jsonl|db|csv|py|ps1|ts|mjs|cjs|js)$',n.value,re.I) and not re.search('auth|secret|credential|token|\.env',n.value,re.I)))
  d['mode_source']=[{'line':i,'code':v} for i,v in enumerate(s.splitlines(),1) if re.search(r'shadow|apply|write.mode|dry.run|output|claim|incident|STATE|sys.argv',v,re.I) and not re.search(r'secret|credential|token|auth|api.key|password|message|body',v,re.I)][:130]
  d['effect_calls']=[{'line':n.lineno,'function':ast.unparse(n.func)} for n in ast.walk(tree) if isinstance(n,ast.Call) and re.search(r'write|dump|save|post|put|delete|run|Popen|replace|unlink|execute|sync',ast.unparse(n.func),re.I)]
 out.append(d)
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Read-only shadow/router review failed'}
