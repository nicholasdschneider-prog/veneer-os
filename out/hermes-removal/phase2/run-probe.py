"""Run one reviewed Phase 2 artifact over Nick's approved SSH connection."""
import base64,gzip,json,subprocess,sys
from pathlib import Path
source,destination=map(Path,sys.argv[1:])
payload=base64.b64encode(gzip.compress(source.read_bytes())).decode()
wrapper="[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g);try { & ([scriptblock]::Create($r.ReadToEnd())) } catch { [Console]::Error.WriteLine($_.Exception.Message);exit 1 }"
command='powershell -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(wrapper.encode('utf-16le')).decode()
r=subprocess.run(['ssh','-i',str(Path.home()/'.ssh/veneer-pc-codex'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','nicho@100.72.128.44',command],input=payload,capture_output=True,text=True,timeout=240)
if r.returncode:print(r.stderr[:1800]);raise SystemExit(r.returncode)
try:data=json.loads(r.stdout.lstrip('\ufeff'))
except ValueError:print('Non-JSON response; inspect source before repeating any mutation. stderr:',r.stderr[:1000]);raise SystemExit(1)
destination.write_text(json.dumps(data,indent=2)+'\n');print(str(destination),'saved',destination.stat().st_size,'bytes')
