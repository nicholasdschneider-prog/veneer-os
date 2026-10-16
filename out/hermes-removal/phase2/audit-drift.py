"""Validate current enabled/Startup changes against this phase's recorded scope."""
from pathlib import Path
import json,sys
p=Path('out/hermes-removal/phase2');current,destination,*expected=sys.argv[1:]
b=json.loads((p/'current-inventory.json').read_text());a=json.loads(Path(current).read_text());o={'at':a['captured'],'baseline':b['captured'],'baseline_note':'Completion Mirror was disabled before baseline'}
for k,key,state in [('cron','id','enabled'),('tasks','name','enabled'),('startup','name','active_extension')]:
 old={j[key]:j for j in b[k]};new={j[key]:j for j in a[k]};o[k]={'changed':[{key:n,'before':old[n].get(state),'after':new[n].get(state)} for n in sorted(old.keys()&new.keys()) if old[n].get(state)!=new[n].get(state)],'added':sorted(new.keys()-old.keys()),'removed':sorted(old.keys()-new.keys())}
checks={'only_expected_cron_changes':{v['id'] for v in o['cron']['changed']}==set(expected),'only_tim_watchdog_change':{v['name'] for v in o['tasks']['changed']}=={'Hermes_CS_Tim_Watchdog'},'all_changed_flags_disabled':all(not v['after'] for v in o['cron']['changed']+o['tasks']['changed']),'only_tim_launcher_rename':o['startup']['added']==['Hermes_Gateway_cs-tim.vbs.disabled-20261016'] and o['startup']['removed']==['Hermes_Gateway_cs-tim.vbs'],'no_added_removed_jobs_tasks':all(not o[k][v] for k in ['cron','tasks'] for v in ['added','removed'])}
o['checks']=checks;o['result']='PASS: HOLD and Tier C states unchanged' if all(checks.values()) else 'REVIEW: unaccounted drift'
Path(destination).write_text(json.dumps(o,indent=2)+'\n');print(o['result']);assert all(checks.values()),checks
