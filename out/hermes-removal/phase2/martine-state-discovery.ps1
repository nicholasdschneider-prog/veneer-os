$py=@'
import pathlib,json,ast,re
p=pathlib.Path(r'C:\Users\nicho\.hermes\scripts\check_martine_reply.py');s=p.read_text(encoding='utf8');t=ast.parse(s)
o={'path':str(p),'state_source':[{'line':i,'code':v[:260]} for i,v in enumerate(s.splitlines(),1) if re.search('state|cursor|checkpoint|fingerprint|last_id|\.txt|\.json|Path\(',v,re.I) and not re.search('secret|token|credential|password|auth|body|message|subject',v,re.I)],'writes':[{'line':n.lineno,'function':ast.unparse(n.func)} for n in ast.walk(t) if isinstance(n,ast.Call) and re.search('write|save|dump|touch|unlink|replace',ast.unparse(n.func),re.I)]}
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Martine state discovery failed'}
