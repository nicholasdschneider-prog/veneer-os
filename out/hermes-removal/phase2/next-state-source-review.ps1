$py=@'
import pathlib,json,ast,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');out=[]
items=[('ervp-manager','inventory-sync-incident-router-wrapper.py'),('ervp-orders','watch_dometic_101592515_reply.py'),('ervp-orders','watch_manual_dometic_100120323_100120506.py'),('root','check_martine_reply.py'),('accounting-migration','accounting_inbox_readonly.py'),('ervp-dev2','lippert_final_tracking_shadow.py')]
for profile,name in items:
 b=r if profile=='root' else r/'profiles'/profile;p=b/'scripts'/name
 if not p.exists():out.append({'profile':profile,'path':str(p),'exists':False});continue
 s=p.read_text(encoding='utf8',errors='replace');d={'profile':profile,'path':str(p),'exists':True,'path_constants':[],'state_assignments':[],'effect_calls':[]}
 try:
  tree=ast.parse(s)
  for n in ast.walk(tree):
   if isinstance(n,ast.Constant) and isinstance(n.value,str):
    v=n.value
    if len(v)<350 and re.search(r'\.(?:json|jsonl|db|sqlite|csv|py|ps1)$',v,re.I):
     if not re.search('credential|secret|token|auth|\.env|key',v,re.I):d['path_constants'].append(v)
   if isinstance(n,(ast.Assign,ast.AnnAssign)):
    targets=n.targets if isinstance(n,ast.Assign) else [n.target]
    names=[ast.unparse(t) for t in targets]
    if any(re.search(r'state|cursor|out(?:put|box)|shadow|claim|incident|fingerprint',t,re.I) for t in names):
     expr=ast.unparse(n.value)
     if len(expr)<450 and not re.search('credential|secret|token|auth|password|api.key',expr,re.I):d['state_assignments'].append({'line':n.lineno,'names':names,'expression':expr})
   if isinstance(n,ast.Call):
    fn=ast.unparse(n.func)
    if re.search(r'write|dump|save|post|put|delete|run|Popen|replace|unlink|execute|sync',fn,re.I):d['effect_calls'].append({'line':n.lineno,'function':fn,'keywords':[k.arg for k in n.keywords]})
  d['imports']=[ast.unparse(n) for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom))]
 except SyntaxError:d['parse_error']=True
 out.append(d)
print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Read-only next state source review failed'}
