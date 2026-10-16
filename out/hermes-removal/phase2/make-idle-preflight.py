from pathlib import Path
import sys
profile=sys.argv[1]
allowed=['cs-mallory','cs-jasmine','cs-rae','cs-ali','cs-joe','cust-service','nick','hermesops-2','accounting-sharon','tripower-consulting','default']
assert profile in allowed
p=Path('out/hermes-removal/phase2')
(p/f'item09-{profile}-preflight.ps1').write_text("$ProfileName='"+profile+"'\n"+(p/'idle-preflight-body.ps1').read_text())
