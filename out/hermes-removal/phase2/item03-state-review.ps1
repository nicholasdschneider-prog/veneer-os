$py=@'
import pathlib,re,json
b=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-manager\scripts');p=b/'inventory-sync-incident-router.cjs';s=p.read_text(encoding='utf8');out={'source_path':str(p),'references':[{'line':i,'code':v[:300]} for i,v in enumerate(s.splitlines(),1) if re.search(r'\.json|statePath|STATE_|cursor|claim|incident.*[Pp]ath',v) and not re.search(r'credential|secret|token|auth|api.key|message|body',v,re.I)][:100]};print(json.dumps(out))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
if($LASTEXITCODE -ne 0){throw 'Router state discovery failed'}
