from pathlib import Path
import sys,json,base64
p=Path('out/hermes-removal/phase2');name=sys.argv[1];stop=json.loads((p/f'item09-{name}-stop.json').read_text());assert stop['profile']==name
encoded=base64.b64encode(json.dumps(stop).encode()).decode()
(p/f'item09-{name}-observe.ps1').write_text("$StopBase64='"+encoded+"'\n"+(p/'idle-observe-body.ps1').read_text())
