$ErrorActionPreference='Stop'
$py=@'
import ast,hashlib,json,pathlib,re
base=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\cust-service')
p=base/'scripts'/'gateway_watchdog.py';s=p.read_text(encoding='utf-8-sig');tree=ast.parse(s)
class Redact(ast.NodeTransformer):
 def visit_Constant(self,n):
  if isinstance(n.value,str) and n.value not in {'cust-service','gateway','run','--profile','-p','pythonw.exe','python.exe','hermes_cli.main','gateway_state.json','state','gateway.heartbeat','gateway_watchdog.lock','gateway_watchdog.log','PATH','PYTHONPATH','HERMES_HOME','LOCALAPPDATA'}:return ast.copy_location(ast.Constant('[literal omitted]'),n)
  return n
cmd=base/'gateway-service'/'Hermes_Gateway_cust-service.cmd';c=cmd.read_text()
print(json.dumps({'watchdog':{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'redacted_ast':ast.unparse(Redact().visit(tree))},'launcher':{'path':str(cmd),'sha256':hashlib.sha256(cmd.read_bytes()).hexdigest(),'gateway_run':bool(re.search(r'gateway\s+run',c)),'profile_cust_service':'cust-service' in c,'command_structure':re.sub(r'"[^"]*"','"[quoted literal omitted]"',c)}}))
'@
$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$b'))"
if($LASTEXITCODE -ne 0){throw 'Read-only dependency review failed'}
