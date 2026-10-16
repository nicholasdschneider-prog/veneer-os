$py=@'
import pathlib,json,re
p=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes\profiles\ervp-orders\scripts\sync_order_completion_board.cjs')
s=p.read_text(encoding='utf8')
print(json.dumps({'path':str(p),'matches':[{'line':i,'code':v} for i,v in enumerate(s.splitlines(),1) if re.search(r'ledger|checkpoint|state|cursor|\.json|readFile|writeFile',v,re.I)]}))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
