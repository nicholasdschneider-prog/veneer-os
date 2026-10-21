$ErrorActionPreference='Stop'
& 'C:\Python314\python.exe' -c "import ast,runpy,json,pathlib; p=pathlib.Path(r'C:\Users\nicho\backups\hermes-final-20261016\archive-quiescent.py'); ast.parse(p.read_text()); d=runpy.run_path(str(p),run_name='operator_preflight'); print(json.dumps({'guard':d['guard'](),'syntax_ok':True,'seal_dir_absent':not d['R'].exists(),'source_sha256':d['sha'](p)}))"
if($LASTEXITCODE -ne 0){throw 'Controller preflight failed; no launch'}
