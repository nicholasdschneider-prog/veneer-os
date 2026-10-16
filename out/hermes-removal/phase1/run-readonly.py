"""Run a reviewed, read-only PowerShell artifact over the authorized SSH connection."""
import base64
import gzip
import json
from pathlib import Path
import subprocess
import sys

source, destination = map(Path, sys.argv[1:])
packed = base64.b64encode(gzip.compress(source.read_bytes())).decode()
wrapper = "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ProgressPreference='SilentlyContinue';$b=[Convert]::FromBase64String('" + packed + "');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g); & ([scriptblock]::Create($r.ReadToEnd()))"
command = 'powershell -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(wrapper.encode('utf-16le')).decode()
if len(command) > 8000:
    raise SystemExit('Read-only probe exceeds Windows command length')
result = subprocess.run(['ssh', '-i', str(Path.home()/'.ssh/veneer-pc-codex'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'nicho@100.72.128.44', command], capture_output=True, text=True, timeout=240)
if result.returncode:
    print(result.stderr[:4000])
    raise SystemExit(result.returncode)
data = json.loads(result.stdout.lstrip('\ufeff'))
destination.write_text(json.dumps(data, indent=2) + '\n')
print(str(destination), 'saved', destination.stat().st_size, 'bytes')
