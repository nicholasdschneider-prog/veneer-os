"""Bounded BUILD301 operator: never prints credentials or unfiltered API bodies."""
import os,json,urllib.request,urllib.error,sys,subprocess
from pathlib import Path
ENV=Path('/Users/archerclawdington/.config/veneer-pro/env')
def runtime():
 out={}
 for line in ENV.read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1);out[k]=v.strip().strip('"').strip("'")
 return out
def api(method,path,data=None):
 req=urllib.request.Request('https://api.cloudflare.com/client/v4'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'X-Auth-Email':os.environ['CLOUDFLARE_ACCOUNT_EMAIL'],'X-Auth-Key':os.environ['CLOUDFLARE_GLOBAL_API_KEY'],'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30) as r: body=json.load(r)
 except urllib.error.HTTPError as e: raise RuntimeError('Cloudflare HTTP '+str(e.code)) from None
 if not body.get('success'):raise RuntimeError('Cloudflare request failed')
 return body['result']
def main():
 cfg=runtime()
 account=cfg.get('VP_APPS_CF_ACCOUNT_ID') or cfg.get('VP_PAGES_CF_ACCOUNT_ID')
 if not account:raise RuntimeError('No configured native Cloudflare account')
 base='/accounts/'+account+'/access'
 apps=api('GET',base+'/apps?per_page=100')
 if len(sys.argv)>1 and sys.argv[1]=='inspect':
  receipt=json.loads(Path(__file__).with_name('provisioned.json').read_text())
  app=api('GET',base+'/apps/'+receipt['applicationId'])
  policies=api('GET',base+'/apps/'+receipt['applicationId']+'/policies')
  print(json.dumps({'app':{k:app.get(k) for k in ['id','domain','aud','destinations','type','service_auth_401_redirect']},'policies':policies}));return
 tokens=api('GET',base+'/service_tokens')
 if len(sys.argv)>1 and sys.argv[1]=='provision':
  origin=cfg.get('VP_APPS_PUBLIC_ORIGIN')
  if origin!='https://nicksworld.dev':raise RuntimeError('Unexpected native origin')
  domain='nicksworld.dev/api/autoship/candidates'
  name='orderops-autoship-candidates'
  matches=[t for t in tokens if t.get('name')==name]
  if matches:raise RuntimeError('Existing named service token: inspect custody before retry, never rotate automatically')
  if any(a.get('domain')==domain for a in apps):raise RuntimeError('Existing verifier app: inspect before retry')
  for k in ['VP_AUTOSHIP_CANDIDATE_CF_AUD','VP_AUTOSHIP_CANDIDATE_CLIENT_ID']:
   if k in cfg:raise RuntimeError('Native candidate key already exists')
  names=subprocess.run(['doppler','secrets','--only-names','--project','ervp','--config','prd','--json'],capture_output=True,check=True)
  if any(k.startswith('OO_AUTOSHIP_CANDIDATE_') for k in json.loads(names.stdout)):raise RuntimeError('Candidate custody already exists')
  token=api('POST',base+'/service_tokens',{'name':name,'duration':'8760h'})
  def store(k,v):
   result=subprocess.run(['doppler','secrets','set',k,'--project','ervp','--config','prd','--silent'],input=v.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if result.returncode:raise RuntimeError('Doppler storage failed for '+k+'; token remains unused')
  store('OO_AUTOSHIP_CANDIDATE_CF_CLIENT_SECRET',token['client_secret'])
  store('OO_AUTOSHIP_CANDIDATE_CF_CLIENT_ID',token['client_id'])
  app=api('POST',base+'/apps',{'name':'Veneer AutoShip Candidates','domain':domain,'type':'self_hosted','session_duration':'0s','service_auth_401_redirect':True})
  policy=api('POST',base+'/apps/'+app['id']+'/policies',{'name':'OrderOps candidate notifications only','decision':'non_identity','include':[{'service_token':{'token_id':token['id']}}]})
  store('OO_AUTOSHIP_CANDIDATE_CF_AUD',app['aud'])
  store('OO_AUTOSHIP_CANDIDATE_ORIGIN',origin)
  receipt={'accountId':account,'origin':origin,'applicationId':app['id'],'audience':app['aud'],'serviceTokenId':token['id'],'serviceClientId':token['client_id'],'policyId':policy['id'],'domain':domain,'secretDestination':'ervp/prd/OO_AUTOSHIP_CANDIDATE_CF_CLIENT_SECRET'}
  Path(__file__).with_name('provisioned.json').write_text(json.dumps(receipt,indent=2)+'\n')
  # Only nonsecret identifiers are installed. Preserve all existing lines/mode.
  values={'VP_AUTOSHIP_CANDIDATE_CF_AUD':app['aud'],'VP_AUTOSHIP_CANDIDATE_CLIENT_ID':token['client_id']}
  current=ENV.read_text()
  for k in values:
   if any(l.startswith(k+'=') for l in current.splitlines()):raise RuntimeError('Runtime key already present; inspect before replacing')
  with ENV.open('a') as out:
   out.write('\n'+'\n'.join(k+'='+v for k,v in values.items())+'\n')
  os.chmod(ENV,0o600)
  print(json.dumps(receipt));return
 print(json.dumps({'accountId':account,'origin':cfg.get('VP_APPS_PUBLIC_ORIGIN'),'candidateConfigNames':[k for k in cfg if 'AUTOSHIP_CANDIDATE' in k],'serviceTokens':[{'id':t['id'],'name':t.get('name')} for t in tokens],'apps':[{'id':a['id'],'name':a.get('name'),'domain':a.get('domain'),'aud':a.get('aud'),'type':a.get('type')} for a in apps]}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(type(e).__name__+': '+str(e));sys.exit(1)
