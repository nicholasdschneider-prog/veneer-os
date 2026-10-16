$py=@'
import pathlib,json,sqlite3,re
r=pathlib.Path(r'C:\Users\nicho\AppData\Local\hermes');o={}
p=r/'hermes-agent'/'hermes_cli'/'gateway.py';a=p.read_text(encoding='utf8').splitlines();o['stop_source']=[{'line':i+1,'code':a[i]} for i in range(1815,1885)]
p=r/'profiles'/'cs-tim'/'cron'/'jobs.json';d=json.loads(p.read_text(encoding='utf8'));jobs=d.get('jobs',[]) if isinstance(d,dict) else d
o['job_shapes']=[{'id':j.get('id'),'keys':list(j),'status':j.get('status'),'last_status':j.get('last_status'),'running':j.get('running'),'script_paths':re.findall(r'[A-Za-z]:\\[^\n"\x27]*?\.(?:py|ps1|json)',str(j))} for j in jobs if j.get('id') in ['b2b5b67f02c0','394f30773d39']]
p=r/'profiles'/'cs-tim'/'cron'/'executions.db'
if p.exists():
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);o['ledger_schema']={row[0]:[v[1] for v in c.execute('pragma table_info("'+row[0]+'")')] for row in c.execute("select name from sqlite_master where type='table'")};c.close()
p=r/'profiles'/'ervp-orders'/'scripts'/'run_order_completion_sync.ps1'
o['mirror_source']=p.read_text(encoding='utf8')[:5000]
print(json.dumps(o))
'@
$e=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
& 'C:\Python314\python.exe' -c "import base64;exec(base64.b64decode('$e'))"
