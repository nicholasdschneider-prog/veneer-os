"""Read-only synthetic-key auth checks. Never prints headers, cookies or tokens."""
import os,json,urllib.request,urllib.error,re
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect)
origin='https://nicksworld.dev'
for label,headers,path in [
 ('dedicated-service',{'CF-Access-Client-Id':os.environ['OO_AUTOSHIP_CANDIDATE_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_AUTOSHIP_CANDIDATE_CF_CLIENT_SECRET']},'/api/autoship/candidates/sources/build301-nonbusiness/events/auth-check'),
 ('no-identity',{},'/api/autoship/candidates/sources/build301-nonbusiness/events/auth-check'),
 ('fake-human-jwt',{'Cf-Access-Jwt-Assertion':'invalid-fixture'},'/api/autoship/candidates/sources/build301-nonbusiness/events/auth-check'),
 ('dedicated-cannot-use-autoship',{'CF-Access-Client-Id':os.environ['OO_AUTOSHIP_CANDIDATE_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_AUTOSHIP_CANDIDATE_CF_CLIENT_SECRET']},'/api/autoship/verifier/decisions/build301-nonbusiness-auth-check')]:
 req=urllib.request.Request(origin+path,headers={**headers,'User-Agent':'Veneer-Candidate-Setup/1.0','Accept':'application/json'})
 try:
  with opener.open(req,timeout=30) as r: status=r.status;body=r.read(2048);response_headers=dict(r.headers)
 except urllib.error.HTTPError as e:status=e.code;body=e.read(2048);response_headers=dict(e.headers)
 message=None
 try:
  parsed=json.loads(body);message=parsed.get('error') if isinstance(parsed,dict) else None
 except Exception:pass
 print(json.dumps({'check':label,'status':status,'expectedNativeMissingSource':message=='Candidate source not found'}))
