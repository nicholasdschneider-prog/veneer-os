from pathlib import Path
import base64,gzip,sys
profile,job,mode,name=sys.argv[1:]
p=Path(__file__).parent
s=base64.b64encode(gzip.compress((p/'cron-control.py').read_bytes())).decode()
ps="$ErrorActionPreference='Stop'\n$py=\"import base64,gzip,sys;sys.argv=['control','"+profile+"','"+job+"','"+mode+"'];exec(gzip.decompress(base64.b64decode('"+s+"')))\"\n& 'C:\\Python314\\python.exe' -c $py\nif($LASTEXITCODE -ne 0){throw 'Cron control failed; inspect source before retry'}\n"
with (p/(name+'.ps1')).open('x') as f:f.write(ps)
