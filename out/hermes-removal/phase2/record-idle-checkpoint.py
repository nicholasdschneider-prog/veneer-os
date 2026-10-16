"""Update isolated operation records from verified receipts; performs no PC action."""
from pathlib import Path,PureWindowsPath
import datetime,hashlib,json,re,sys
p=Path(__file__).resolve().parent
previous,current,next_profile,archive_name=sys.argv[1:]
read=lambda name:json.loads((p/name).read_text())
state=read('phase2-state.json')
assert previous in state['idle_profile_order'] and current in state['idle_profile_order'] and next_profile in state['idle_profile_order']
final=read(f'item09-{previous}-final.json');post=read(f'item09-{previous}-post.json');stop=read(f'item09-{current}-stop.json');interim=read(f'item09-{current}-interim.json')
assert all(final['checks'].values()) and post['ledger']['unfinished_all_profile']==0 and not post['gateways']
assert not stop['remaining_gateways'] and all(v for k,v in interim['checks'].items() if k!='full_15m')
state['idle_profiles'][previous].update(status='verified',confirmed_at=final['at'],final_receipt=f'item09-{previous}-final.json',post_receipt=f'item09-{previous}-post.json')
start=datetime.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+',r'\1',stop['observation_start']))
due=(start+datetime.timedelta(seconds=900)).astimezone(datetime.timezone.utc)
state['idle_profiles'][current]={'status':'observing','observation_start':stop['observation_start'],'not_before_utc':due.isoformat(),'stop_receipt':f'item09-{current}-stop.json','observe_probe':f'item09-{current}-observe.ps1'}
state['next_profile']=next_profile
archive=read(archive_name)['status']['status.json'];errors=archive.get('errors',[])
state['archive'].update(state=archive['state']+'_unverified',files_hashed=archive.get('files_hashed',archive.get('files')),errors=errors if isinstance(errors,int) else len(errors))
(p/'phase2-state.json').write_text(json.dumps(state,indent=2)+'\n')
verified=[n for n in state['idle_profile_order'] if state['idle_profiles'].get(n,{}).get('status')=='verified']
local_due=due.astimezone(start.tzinfo).strftime('%H:%M:%S')
f=p/'README.md';s=f.read_text();lines=s.splitlines()
for i,l in enumerate(lines):
 if l.startswith('| 9 Idle gateways'):
  lines[i]=f"| 9 Idle gateways | {', '.join(verified)} verified; {current} observing | {previous} passed all final checks and post-read unfinished=0. {current} launch sources retired {start.strftime('%H:%M:%S')} ET after idle/dependency/identity checks; active watchdogs disabled or confirmed absent, active Startup renamed, exact gateway stops recorded only when present, interim checks passed. Require full 15 minutes through {local_due} ET before {next_profile}. Remaining profiles untouched. |"
s='\n'.join(lines)+'\n'
s=re.sub(r'At \d\d:\d\d ET its status reported [\d,]+ files hashed, [\d,]+ bytes, and [\d,]+ accumulated errors(?: \(count stable\))?\.',f"At {datetime.datetime.now().strftime('%H:%M')} ET its status reported {archive.get('files_hashed',0):,} files hashed, {archive.get('bytes',0):,} bytes, and {state['archive']['errors']:,} accumulated errors.",s)
a=s.index('At the next wake');b=s.index('Generic isolated helpers',a)
s=s[:a]+f'''At the next wake after {local_due} ET, run item09-{current}-observe.ps1 into item09-{current}-final.json and require every check including >=900 seconds. Re-run its EXISTING preflight probe into DISTINCT item09-{current}-post.json, confirming zero ALL unfinished/no gateway/no enabled dependency. Do not overwrite original preflight JSON or repeat the stop. After it passes, begin {next_profile}, with fresh preflight and inspected task action metadata.\n\nRead phase2-state.json for current progress and exact UTC deadline. record-idle-checkpoint.py updates only local operation records from successful receipts; it does not execute PC actions. audit-expected.json records exact prior authorized changes for drift comparison. Never mutate a later profile before the current observation passes.\n\n'''+s[b:]
cron_ids=['b2b5b67f02c0','394f30773d39','d68cb0c1ae05','330388e25e93','305da2ff8a02','ce772d25016e','2ecec57ee69b','89de9427e76b','917a1ee90aec']
tasks=['ERVP Hermes Dashboard'];startup=[];sources=[]
for name in state['idle_profiles']:
 receipt=f'item09-{name}-stop.json';r=read(receipt);sources.append(receipt);tasks.extend(t['name'] for t in r['tasks']);startup.extend(PureWindowsPath(v['old']).name for v in r['launchers'])
(p/'audit-expected.json').write_text(json.dumps({'cron_ids':cron_ids,'extra_tasks':tasks,'extra_startup':startup,'source_stop_receipts':sources,'note':'Tim watchdog and Startup are implicit in audit-drift.py; entries here come only from performed authorized stop receipts.'},indent=2)+'\n')
s=s.split('## Artifacts')[0]+'## Artifacts\n\n'
for x in sorted(p.iterdir()):
 if x.is_file() and x.name!='README.md':s+=f'- [{x.name}]({x.resolve()})\n'
f.write_text(s)
(p/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(x.read_bytes()).hexdigest()+'  '+x.name+'\n' for x in sorted(p.iterdir()) if x.is_file() and x.name!='SHA256SUMS.txt'))
print('Checkpoint updated; next observation not before',due.isoformat())
