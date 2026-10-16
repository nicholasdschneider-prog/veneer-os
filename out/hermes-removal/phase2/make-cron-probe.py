from pathlib import Path
import base64,gzip,sys
profile,job,mode,name=sys.argv[1:]
s=base64.b64encode(gzip.compress(Path('out/hermes-removal/phase2/cron-control.py').read_bytes())).decode()
ps="$ErrorActionPreference='Stop'\n$py=\"import base64,gzip,sys;sys.argv=['control','"+profile+"','"+job+"','"+mode+"'];exec(gzip.decompress(base64.b64decode('"+s+"')))\"\n& 'C:\\Python314\\python.exe' -c $py\nif($LASTEXITCODE -ne 0){throw 'Cron control failed; inspect source before retry'}\n"
Path('out/hermes-removal/phase2/'+name+'.ps1').write_text(ps)
