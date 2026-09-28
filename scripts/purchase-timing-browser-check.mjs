// Disposable browser acceptance. Every API request is mocked; no business calls.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const output=process.argv[3]??new URL('../docs/reports/purchase-timing/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3299,strictPort:true}});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const mobile of [false,true]){
  const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));let configured=false;const calls=[];
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path.startsWith('/api/purchase-timing/setup')){
    calls.push({path,method:req.method(),body:req.postDataJSON()});
    if(path.endsWith('/review'))return route.fulfill({json:{status:'ready',review_hash:'fixture-hash',enrollment:{...req.postDataJSON(),audience:'dedicated-timing-fixture',client_id:'dedicated-client-fixture'},receipt:null}});
    if(path.endsWith('/confirm'))return route.abort();
    if(path.includes('/registrations/'))return route.fulfill({json:{trust_id:'fixture-trust',request_key:'fixture-key',revoked:false,account_id:'fixture-account'}});
    return route.fulfill({json:{configured,businesses:[{id:'fixture-team',name:'Example business'}],executors:[{id:'fixture-sage',title:'Example purchasing bot',business_team_id:'fixture-team'}]}});
   }
   if(path==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'fixture@example.test',displayName:'Example owner',role:'owner',employeeWorkspace:false}}});
   if(path==='/api/navigation')return route.fulfill({json:{configured:true,navigation:{items:[]}}});
   if(path==='/api/page-brand')return route.fulfill({json:{brand:{}}});
   return route.fulfill({status:404,json:{error:'Unavailable in isolated fixture'}});
  });
  await page.goto('http://127.0.0.1:3299/#/purchase-timing-setup');
  await page.getByRole('heading',{name:'Technical setup is still needed'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Confirm connection'}).count(),0);
  await page.screenshot({path:`${output}/${mobile?'mobile':'desktop'}-blocked.png`,fullPage:true});
  configured=true;await page.reload();
  await page.getByLabel('Business',{exact:true}).selectOption('fixture-team');
  await page.getByLabel('Existing purchasing bot',{exact:true}).selectOption('fixture-sage');
  for(const [label,value] of [['Stable registration key','fixture-key'],['Source HTTPS origin','https://source.example.test'],['Source account ID','fixture-account'],['Source principal ID','fixture-principal'],['Verified source deployment','fixture-revision'],['Source custody receipt','fixture-receipt']])await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByRole('button',{name:'Review connection'}).click();
  await page.getByRole('heading',{name:'Review the exact connection'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`${output}/${mobile?'mobile':'desktop'}-review.png`,fullPage:true});
  await page.getByRole('button',{name:'Confirm connection'}).click();
  await page.getByRole('button',{name:'Check registration status'}).click();
  await page.getByRole('heading',{name:'Connection registered'}).waitFor();
  assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,1);
  assert.equal(calls.at(-1).method,'GET');assert.equal(calls.at(-1).path,'/api/purchase-timing/setup/registrations/fixture-key');
  assert.equal(calls.find(c=>c.path.endsWith('/confirm')).body.enrollment.executor_id,'fixture-sage');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Purchase timing setup passed: desktop/mobile, technical blocker, exact review, one confirmation, lost-response GET reconciliation, no overflow or page errors. All data synthetic.');
}finally{await browser.close();await vite.close();}
