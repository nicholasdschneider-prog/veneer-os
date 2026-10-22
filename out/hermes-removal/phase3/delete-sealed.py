"""Execute only the sealed, explicitly authorized Hermes removal plan; never run Hermes."""
from pathlib import Path
import os,json,hashlib,datetime,subprocess,base64,shutil,re
H=Path(r'C:\Users\nicho');B=H/'backups/hermes-final-20261016';C=B/'phase3-custody-20261022';D=B/'phase3-delete-20261022';X=chr(92)*2+'?'+chr(92)
def ext(p):return str(p) if str(p).startswith(X) else X+str(p)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):
 h=hashlib.sha256()
 with open(ext(p),'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def write(n,v):
 tmp=D/(n+'.next');tmp.write_text(json.dumps(v,indent=2)+'\n');os.replace(tmp,D/n)
def log(v):
 with (D/'journal.jsonl').open('a') as f:f.write(json.dumps({'at':now(),**v})+'\n');f.flush();os.fsync(f.fileno())
def ps(code):
 # No shell interpolation. PowerShell runs only reviewed removal/metadata commands.
 r=subprocess.run(['powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(code.encode('utf-16le')).decode()],capture_output=True,text=True)
 if r.returncode:raise RuntimeError('Removal helper failed; inspect source journal before any retry')
 return json.loads(r.stdout.lstrip('\ufeff'))
def quote(s):return "'"+str(s).replace("'","''")+"'"
def remove_file(p):
 return ps("$ErrorActionPreference='Stop';$e=@();Remove-Item -LiteralPath "+quote(ext(p))+" -Force -Confirm:$false -ErrorAction SilentlyContinue -ErrorVariable +e;@{errors=@($e|ForEach-Object{@{type=$_.Exception.GetType().Name;id=$_.FullyQualifiedErrorId}})}|ConvertTo-Json -Depth 5")
def measure(root):
 if not os.path.lexists(ext(root)):return {'bytes':0,'files':0,'links':[],'exists':False}
 if root.is_symlink() or root.is_junction():raise RuntimeError('Source root became reparse point')
 total=count=0;links=[];errors=[]
 def err(e):errors.append({'path':e.filename,'error':type(e).__name__})
 for current,dirs,files in os.walk(ext(root),followlinks=False,onerror=err):
  base=Path(current);kept=[]
  for n in dirs:
   f=base/n
   if f.is_symlink() or f.is_junction():links.append({'path':str(f)[len(X):],'target':os.readlink(ext(f))})
   else:kept.append(n)
  dirs[:]=kept
  for n in files:
   f=base/n
   if f.is_symlink():links.append({'path':str(f)[len(X):],'target':os.readlink(ext(f))});continue
   try:total+=os.stat(ext(f)).st_size;count+=1
   except OSError as e:err(e)
 return {'bytes':total,'files':count,'links':links,'errors':errors,'exists':True}
def main():
 if D.exists():raise RuntimeError('Deletion journal exists: never blind replay')
 seal=json.loads((B/'phase3-sealed-verdict-20261022.json').read_text());assert seal['sealed'] and seal['deletion_permitted'] and seal['verdict']=='VERIFIED_QUIESCENT_SEAL'
 assert not seal['incomplete_checks'];assert sha(B/'quiescent-r3-20261022/manifest-current.jsonl')==seal['manifest_sha256'];assert sha(C/'deletion-plan.json')==seal['deletion_plan_sha256']
 plan=json.loads((C/'deletion-plan.json').read_text());assert plan['state']=='ready_for_seal';assert all(Path(x).exists() for x in plan['keep'])
 allowed={'worktrees':H/'.worktrees','legacy-data':H/'HermesLegacyData','dot-hermes':H/'.hermes','brain-ops':H/'HermesBrainOps','local-hermes':H/'AppData/Local/hermes','obsidian-brain':H/'ObsidianVaults/Hermes Brain'}
 assert {r['label']:Path(r['path']) for r in plan['roots']}==allowed
 assert all(x['hermes_owned'] for x in plan['worktrees']);assert seal['obsidian_brain_verified']
 D.mkdir();write('status.json',{'state':'deleting_infrastructure','at':now(),'sealed':True});free_before=shutil.disk_usage(H).free;results=[]
 # Every effect gets a durable intent and result; there is no retry loop.
 for i,t in enumerate(plan['tasks']):
  assert t['name']!='ERVP_Dometic_Inventory';assert sha(Path(t['archive_path'])).upper()==t['sha256'].upper();log({'stage':'task','intent':t})
  code="$ErrorActionPreference='Stop';$name="+quote(t['name'])+";$path="+quote(t['task_path'])+";$t=Get-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction Stop;if($t.Settings.Enabled){throw 'Task enabled after seal'};$xml=Export-ScheduledTask -TaskName $name -TaskPath $path;$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($xml))).Replace('-','');if($h -ne "+quote(t['sha256'])+"){throw 'Task XML changed after custody'};$e=@();Unregister-ScheduledTask -TaskName $name -TaskPath $path -Confirm:$false -ErrorAction SilentlyContinue -ErrorVariable +e;@{exists_after=($null -ne (Get-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction SilentlyContinue));errors=@($e|ForEach-Object{@{type=$_.Exception.GetType().Name;id=$_.FullyQualifiedErrorId}})}|ConvertTo-Json -Depth 5"
  outcome=ps(code);rec={'stage':'task','name':t['name'],'original_xml_sha256':t['sha256'],'bytes_before':t['bytes'],'bytes_after':t['bytes'] if outcome['exists_after'] else 0,'archive_path':t['archive_path'],**outcome};results.append(rec);log({'result':rec})
 for kind,items in [('startup',plan['startups']),('wrapper',plan['wrappers'])]:
  for item in items:
   p=Path(item['path']);assert sha(p)==item['sha256'],'Source wrapper changed after seal'
   archive=Path(item['archive_path']) if Path(item['archive_path']).is_absolute() else B/Path(item['archive_path']);assert sha(archive)==item['sha256'];log({'stage':kind,'intent':item});outcome=remove_file(p);exists=os.path.lexists(ext(p));rec={'stage':kind,'path':str(p),'sha256':item['sha256'],'bytes_before':item['bytes'],'bytes_after':os.stat(ext(p)).st_size if exists else 0,'exists_after':exists,'archive_path':item['archive_path'],**outcome};results.append(rec);log({'result':rec})
 write('status.json',{'state':'deleting_roots','at':now(),'infrastructure_entries':len(results)})
 for label in ['worktrees','legacy-data','dot-hermes','brain-ops','local-hermes','obsidian-brain']:
  root=allowed[label];before=measure(root);log({'stage':'root','label':label,'path':str(root),'intent':True,'before':before});write('status.json',{'state':'deleting_root','root':label,'at':now(),'before':before})
  # Remove reparse entries themselves without recursion before deleting their owning root.
  failed_links=[]
  for link in sorted(before['links'],key=lambda x:len(x['path']),reverse=True):
   p=Path(link['path']);assert p.is_relative_to(root);assert os.readlink(ext(p))==link['target'];log({'stage':'reparse','intent':link});outcome=remove_file(p);exists=os.path.lexists(ext(p));log({'stage':'reparse','path':str(p),'exists_after':exists,'outcome':outcome})
   if exists:failed_links.append(link)
  if failed_links:
   outcome={'errors':[{'type':'ReparseEntriesRetained','paths':[x['path'] for x in failed_links]}],'root_recursion_skipped':True}
  else:
   outcome=ps("$ErrorActionPreference='Stop';$e=@();Remove-Item -LiteralPath "+quote(ext(root))+" -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -ErrorVariable +e;@{errors=@($e|ForEach-Object{@{type=$_.Exception.GetType().Name;id=$_.FullyQualifiedErrorId;path=[string]$_.TargetObject}})}|ConvertTo-Json -Depth 5")
  after=measure(root);rec={'stage':'root','label':label,'path':str(root),'bytes_before':before['bytes'],'files_before':before['files'],'bytes_after':after['bytes'],'files_after':after['files'],'exists_after':after['exists'],**outcome};results.append(rec);log({'result':rec});write('results-partial.json',results)
 kept={'paths':[{'path':x,'exists':Path(x).exists()} for x in plan['keep']],'startup':[{'path':x['path'],'exists':Path(x['path']).exists(),'hash_unchanged':Path(x['path']).exists() and sha(Path(x['path']))==x['sha256']} for x in plan['keep_startup']]}
 taskkeep=ps("$t=Get-ScheduledTask -TaskName 'ERVP_Dometic_Inventory' -ErrorAction Stop;@{name=$t.TaskName;enabled=$t.Settings.Enabled;exists=$true}|ConvertTo-Json")
 report={'state':'removal_complete' if not any(x.get('exists_after') for x in results) else 'removal_complete_with_leftovers','at':now(),'seal_path':str(B/'phase3-sealed-verdict-20261022.json'),'manifest_sha256':seal['manifest_sha256'],'archive_root':str(B),'free_bytes_before':free_before,'free_bytes_after':shutil.disk_usage(H).free,'results':results,'kept':kept,'kept_task':taskkeep,'locked_or_retained':[x for x in results if x.get('exists_after')],'no_reboot':True,'no_business_job_run':True}
 write('verification.json',report);write('status.json',{k:v for k,v in report.items() if k not in ['results','kept','locked_or_retained']})
if __name__=='__main__':
 try:main()
 except Exception as e:
  if D.exists():write('failure.json',{'at':now(),'error':type(e).__name__,'message':str(e),'inspect_journal_before_any_retry':True});write('status.json',{'state':'failed','at':now()})
  raise
