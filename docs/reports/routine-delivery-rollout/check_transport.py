"""Read-only synthetic-key auth checks. Never prints headers, cookies or tokens."""
import os,json,urllib.request,urllib.error,re
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect)
origin='https://nicksworld.dev'
for label,headers,path in [
 ('dedicated-service',{'CF-Access-Client-Id':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET']},'/api/routine-message/verifier/drafts/build339-nonbusiness-auth-check'),
 ('return-cannot-use-routine',{'CF-Access-Client-Id':os.environ['OO_RETURN_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_RETURN_VERIFIER_CF_CLIENT_SECRET']},'/api/routine-message/verifier/drafts/build339-nonbusiness-auth-check'),
 ('autoship-cannot-use-routine',{'CF-Access-Client-Id':os.environ['AUTOSHIP_VERIFIER_CF_ACCESS_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['AUTOSHIP_VERIFIER_CF_ACCESS_CLIENT_SECRET']},'/api/routine-message/verifier/drafts/build339-nonbusiness-auth-check'),
 ('no-identity',{},'/api/routine-message/verifier/drafts/build339-nonbusiness-auth-check'),
 ('fake-human-jwt',{'Cf-Access-Jwt-Assertion':'invalid-fixture'},'/api/routine-message/verifier/drafts/build339-nonbusiness-auth-check'),
 ('dedicated-cannot-use-return',{'CF-Access-Client-Id':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET']},'/api/return-exception/verifier/claims/build339-nonbusiness-auth-check'),
 ('dedicated-cannot-use-autoship',{'CF-Access-Client-Id':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET']},'/api/autoship/verifier/decisions/build339-nonbusiness-auth-check')]:
 req=urllib.request.Request(origin+path,headers={**headers,'User-Agent':'Veneer-Routine-Verifier/1.0','Accept':'application/json'})
 try:
  with opener.open(req,timeout=30) as r: status=r.status;body=r.read(2048);response_headers=dict(r.headers)
 except urllib.error.HTTPError as e:status=e.code;body=e.read(2048);response_headers=dict(e.headers)
 message=None
 try:
  parsed=json.loads(body);message=parsed.get('error') if isinstance(parsed,dict) else None
 except Exception:pass
 print(json.dumps({'check':label,'status':status,'expectedNativeMissingAuthorization':message=='Routine authorization not found','nativeError':message if isinstance(message,str) and len(message)<120 else None,'pageTitle':re.findall(b'<title>([^<]{0,150})</title>',body)[0].decode() if re.findall(b'<title>([^<]{0,150})</title>',body) else None}))
