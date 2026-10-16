from pathlib import Path
import json,sys,base64
p=Path('out/hermes-removal/phase2');name=sys.argv[1];cfg=json.loads((p/f'item09-{name}-preflight.json').read_text())
assert name==cfg['profile'] and name in ['cs-mallory','cs-jasmine','cs-rae','cs-ali','cs-joe','cust-service','nick','hermesops-2','accounting-sharon','tripower-consulting']
assert not cfg['enabled_cron_ids'] and cfg['ledger']['unfinished_all_profile']==0
custody=False
if name in ['accounting-sharon','tripower-consulting']:
 receipt=json.loads(Path(sys.argv[2]).read_text());assert receipt['profile']==name and receipt['custody_metadata_captured'];custody=True
encoded=base64.b64encode(json.dumps(cfg).encode()).decode()
(p/f'item09-{name}-stop.ps1').write_text("$ConfigBase64='"+encoded+"'\n$CustodyConfirmed=$"+str(custody).lower()+"\n"+(p/'idle-stop-body.ps1').read_text())
