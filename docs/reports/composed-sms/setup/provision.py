"""Exact compose-only operator; metadata only output, no runtime activation."""
import os,json,sys,urllib.request,urllib.error,subprocess,secrets,hashlib,uuid,datetime
from pathlib import Path
HERE=Path(__file__).parent
NAME='orderops-composed-sms-verifier'
DOMAIN='nicksworld.dev/api/composed-sms/verifier'
DEST=['OO_COMPOSE_SMS_CF_CLIENT_ID','OO_COMPOSE_SMS_CF_CLIENT_SECRET','OO_COMPOSE_SMS_NATIVE_BEARER','OO_COMPOSE_SMS_NATIVE_READBACK_CREDENTIAL']
def api(method,path,data=None):
 req=urllib.request.Request('https://api.cloudflare.com/client/v4'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'X-Auth-Email':os.environ['CLOUDFLARE_ACCOUNT_EMAIL'],'X-Auth-Key':os.environ['CLOUDFLARE_GLOBAL_API_KEY'],'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30) as r:b=json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError('Cloudflare HTTP '+str(e.code)) from None
 if not b.get('success'):raise RuntimeError('Cloudflare operation denied')
 return b

def main():
 cfg={}
 for line in Path('/Users/archerclawdington/.config/veneer-pro/env').read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1)
   if k in ['VP_APPS_PUBLIC_ORIGIN','VP_APPS_CF_ACCOUNT_ID','VP_PAGES_CF_ACCOUNT_ID']:cfg[k]=v.strip().strip('"').strip("'")
 if cfg.get('VP_APPS_PUBLIC_ORIGIN')!='https://nicksworld.dev':raise RuntimeError('Native origin mismatch')
 account=cfg.get('VP_APPS_CF_ACCOUNT_ID') or cfg.get('VP_PAGES_CF_ACCOUNT_ID')
 if not account:raise RuntimeError('Native Cloudflare account unavailable')
 base='/accounts/'+account+'/access'
 apps=api('GET',base+'/apps?per_page=100')
 if apps.get('result_info',{}).get('total_pages',1)>1:raise RuntimeError('App inventory requires additional pages')
 tokens=api('GET',base+'/service_tokens?per_page=100')
 if tokens.get('result_info',{}).get('total_pages',1)>1:raise RuntimeError('Token inventory requires additional pages')
 matches=[{k:a.get(k) for k in ['id','name','domain','aud']} for a in apps['result'] if a.get('domain','').startswith(DOMAIN) or a.get('name')==NAME]
 tokenmatches=[{k:t.get(k) for k in ['id','name']} for t in tokens['result'] if t.get('name')==NAME]
 names=subprocess.run(['doppler','secrets','--only-names','--project','ervp','--config','prd','--json'],capture_output=True,check=True)
 present=[k for k in json.loads(names.stdout) if k.startswith('OO_COMPOSE_SMS_')]
 receipt={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'accountId':account,'nativeOrigin':cfg['VP_APPS_PUBLIC_ORIGIN'],'appMatches':matches,'tokenMatches':tokenmatches,'sourceDestinationNamesPresent':present,'operatorReference':'main/prd CLOUDFLARE_ACCOUNT_EMAIL + CLOUDFLARE_GLOBAL_API_KEY','sourceRuntimeInstallation':False,'nativeServiceRegistrationActivated':False}
 (HERE/'custody-inspection.json').write_text(json.dumps(receipt,indent=2)+'\n')
 if len(sys.argv)==1 or sys.argv[1]!='provision':print(json.dumps(receipt));return
 if matches or tokenmatches or present or (HERE/'provisioned.json').exists():raise RuntimeError('Existing compose resources: reconcile exact receipt, no automatic retry/overwrite')
 receipt.update({'registrationId':str(uuid.uuid4()),'registrationRevision':1,'expiresAt':'2026-10-28T21:04:00Z','domain':DOMAIN})
 def save(): (HERE/'provisioned.json').write_text(json.dumps(receipt,indent=2)+'\n')
 def store(k,v):
  p=subprocess.run(['doppler','secrets','set',k,'--project','ervp','--config','prd','--silent'],input=v.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if p.returncode:raise RuntimeError('Protected destination write failed: '+k+'; preserve resources and reconcile')
 save()
 token=api('POST',base+'/service_tokens',{'name':NAME,'duration':'696h'})['result']
 receipt.update({'serviceTokenId':token['id'],'serviceClientId':token['client_id'],'serviceTokenExpiresAt':token.get('expires_at')});save()
 store(DEST[1],token['client_secret']);store(DEST[0],token['client_id']);del token
 bearer=secrets.token_urlsafe(48);receipt['serviceCredentialHash']=hashlib.sha256(bearer.encode()).hexdigest();store(DEST[2],bearer);del bearer;save()
 reverse=secrets.token_urlsafe(48);receipt['readbackCredentialHash']=hashlib.sha256(reverse.encode()).hexdigest();store(DEST[3],reverse);del reverse;save()
 app=api('POST',base+'/apps',{'name':NAME,'domain':DOMAIN,'type':'self_hosted','session_duration':'0s','service_auth_401_redirect':True})['result']
 receipt.update({'applicationId':app['id'],'audience':app['aud']});save()
 policy=api('POST',base+'/apps/'+app['id']+'/policies',{'name':'Dedicated composed SMS source only','decision':'non_identity','include':[{'service_token':{'token_id':receipt['serviceTokenId']}}]})['result']
 receipt['policyId']=policy['id'];save()
 check=api('GET',base+'/apps/'+app['id']+'/policies')['result']
 if len(check)!=1 or check[0].get('decision')!='non_identity' or check[0].get('include')!=[{'service_token':{'token_id':receipt['serviceTokenId']}}] or check[0].get('exclude') or check[0].get('require'):raise RuntimeError('Exact dedicated policy readback mismatch')
 receipt.update({'policyVerified':True,'sourceSecretDestinations':['ervp/prd/'+k for k in DEST],'provisionedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()});save();print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except Exception as e:print(type(e).__name__+': '+str(e) if isinstance(e,RuntimeError) else 'Operator failed; no retry without metadata reconciliation');sys.exit(1)
