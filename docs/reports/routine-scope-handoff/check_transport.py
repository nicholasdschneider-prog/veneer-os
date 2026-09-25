"""Read-only synthetic handoff authentication checks; no tokens/headers/bodies logged."""
import os,json,urllib.request,urllib.error,sys
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect)
service={'CF-Access-Client-Id':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET']}
checks=[('dedicated-exact-absent',service,'/api/routine-message/verifier/scope-handoffs/build343-absent',404,'Scope handoff not found'),
 ('dedicated-no-inventory',service,'/api/routine-message/verifier/scope-handoffs',405,'Unsupported routine verifier operation'),
 ('no-identity',{},'/api/routine-message/verifier/scope-handoffs/build343-absent',401,None),
 ('return-denied',{'CF-Access-Client-Id':os.environ['OO_RETURN_VERIFIER_CF_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['OO_RETURN_VERIFIER_CF_CLIENT_SECRET']},'/api/routine-message/verifier/scope-handoffs/build343-absent',401,None)]
passed=True
for label,headers,path,expected,message in checks:
 req=urllib.request.Request('https://nicksworld.dev'+path,headers={**headers,'User-Agent':'Veneer-Routine-Verifier/1.0','Accept':'application/json'})
 try:
  with opener.open(req,timeout=30) as response:status=response.status;body=response.read(2048)
 except urllib.error.HTTPError as e:status=e.code;body=e.read(2048)
 actual=None
 try:actual=json.loads(body).get('error')
 except (ValueError,AttributeError):pass
 ok=status==expected and (message is None or actual==message);passed=passed and ok
 print(json.dumps({'check':label,'status':status,'passed':ok,'expected_native_error_matched':actual==message if message else None}))
if not passed:sys.exit(1)
