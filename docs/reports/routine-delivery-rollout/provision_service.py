"""Bounded BUILD339 operator: never prints credentials or unfiltered API bodies."""
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
def listing(path):
 out=[]
 for page in range(1,101):
  rows=api('GET',path+'?per_page=100&page='+str(page))
  out.extend(rows)
  if len(rows)<100:return out
 raise RuntimeError('Cloudflare listing incomplete; refusing provisioning')
def main():
 cfg=runtime()
 account=cfg.get('VP_APPS_CF_ACCOUNT_ID') or cfg.get('VP_PAGES_CF_ACCOUNT_ID')
 if not account:raise RuntimeError('No configured native Cloudflare account')
 base='/accounts/'+account+'/access'
 apps=listing(base+'/apps')
 if len(sys.argv)>1 and sys.argv[1]=='inspect':
  receipt=json.loads(Path(__file__).with_name('provisioned.json').read_text())
  app=api('GET',base+'/apps/'+receipt['applicationId'])
  policies=api('GET',base+'/apps/'+receipt['applicationId']+'/policies')
  print(json.dumps({'app':{k:app.get(k) for k in ['id','domain','aud','destinations','type','service_auth_401_redirect']},'policies':[{'id':p.get('id'),'decision':p.get('decision'),'include':p.get('include'),'exclude':p.get('exclude'),'require':p.get('require')} for p in policies]}));return
 if len(sys.argv)>1 and sys.argv[1]=='provision':
  origin=cfg.get('VP_APPS_PUBLIC_ORIGIN')
  if origin!='https://nicksworld.dev':raise RuntimeError('Unexpected native origin')
  domain='nicksworld.dev/api/routine-message/verifier'
  name='orderops-routine-message-verifier'
  tokens=listing(base+'/service_tokens')
  if any(k in cfg for k in ['VP_ROUTINE_VERIFIER_CF_AUD','VP_ROUTINE_VERIFIER_CLIENT_ID']):raise RuntimeError('Native routine configuration already exists; reconcile first')
  matches=[t for t in tokens if t.get('name')==name]
  if matches:raise RuntimeError('Existing named service token: inspect custody before retry, never rotate automatically')
  if any(a.get('domain','').rstrip('/*')==domain or a.get('name')=='Veneer Routine Message Verifier' for a in apps):raise RuntimeError('Existing verifier app: inspect before retry')
  token=api('POST',base+'/service_tokens',{'name':name,'duration':'8760h'})
  def store(k,v):
   result=subprocess.run(['doppler','secrets','set',k,'--project','ervp','--config','prd','--silent'],input=v.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if result.returncode:raise RuntimeError('Doppler storage failed for '+k+'; token remains unused')
  store('OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET',token['client_secret'])
  store('OO_ROUTINE_VERIFIER_CF_CLIENT_ID',token['client_id'])
  app=api('POST',base+'/apps',{'name':'Veneer Routine Message Verifier','domain':domain,'type':'self_hosted','session_duration':'0s','service_auth_401_redirect':True})
  policy=api('POST',base+'/apps/'+app['id']+'/policies',{'name':'OrderOps routine message verifier','decision':'non_identity','include':[{'service_token':{'token_id':token['id']}}]})
  store('OO_ROUTINE_VERIFIER_CF_AUD',app['aud'])
  store('OO_ROUTINE_VERIFIER_ORIGIN',origin)
  receipt={'accountId':account,'origin':origin,'applicationId':app['id'],'audience':app['aud'],'serviceTokenId':token['id'],'serviceClientId':token['client_id'],'policyId':policy['id'],'domain':domain,'secretDestination':'ervp/prd/OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET'}
  Path(__file__).with_name('provisioned.json').write_text(json.dumps(receipt,indent=2)+'\n')
  # Only nonsecret identifiers are installed. Preserve all existing lines/mode.
  values={'VP_ROUTINE_VERIFIER_CF_AUD':app['aud'],'VP_ROUTINE_VERIFIER_CLIENT_ID':token['client_id']}
  current=ENV.read_text()
  for k in values:
   if any(l.startswith(k+'=') for l in current.splitlines()):raise RuntimeError('Runtime key already present; inspect before replacing')
  with ENV.open('a') as out:
   out.write('\n'+'\n'.join(k+'='+v for k,v in values.items())+'\n')
  os.chmod(ENV,0o600)
  print(json.dumps(receipt));return
 print(json.dumps({'accountId':account,'origin':cfg.get('VP_APPS_PUBLIC_ORIGIN'),'apps':[{'id':a['id'],'name':a.get('name'),'domain':a.get('domain'),'aud':a.get('aud'),'type':a.get('type')} for a in apps]}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(str(e) if isinstance(e,RuntimeError) else 'Provisioning failed; reconcile metadata before retry');sys.exit(1)
