// Full-app synthetic HTTP fixtures only: never enrolls a real owner or uses credentials.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true}});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/return-owner-ui/',import.meta.url).pathname;await mkdir(output,{recursive:true});
const fixture=()=>({review_hash:'fixture-review',status:'ready',receipt:null,manifest:{boundary:{source_origin:'https://source.example.test',project:'fixture-project'},registration_basis:'New fixture registration, not historical authority.',principal_evidence:'Fixture own-principal receipt.'},payload:{request_key:'fixture-stable-key',account_id:'fixture-account'}});
try {
 for(const width of [375,1440]) for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:1000}});let setup=fixture(),posts=0,deny=false,unknown=true;const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'owner@fixture.test',role:'owner',employeeWorkspace:width===375}}});
   if(p==='/api/bot-communication/return-exception/setup'){
    if(deny)return route.fulfill({status:403,json:{error:'Sign in as the current business owner.'}});
    if(route.request().method()==='POST'){
     posts++;assert.deepEqual(route.request().postDataJSON(),{review_hash:'fixture-review',confirm:true});
     setup={...setup,status:'registered',receipt:{trust_id:'fixture-trust',owner_id:1,account_id:'fixture-account',request_key:'fixture-stable-key',created_at:'2026-09-24'}};
     if(unknown)return route.abort('failed');
    }
    return route.fulfill({json:setup});
   }
   if(p==='/api/navigation')return route.fulfill({json:{configured:true,navigation:{items:[]}}});
   if(p==='/api/page-brand')return route.fulfill({json:{brand:{}}});
   return route.fulfill({status:404,json:{error:'Not a fixture endpoint'}});
  });
  await page.goto('http://127.0.0.1:3297/#/return-service-setup');
  const confirm=page.getByRole('button',{name:'Confirm return service setup'});await confirm.waitFor();assert.equal(posts,0);
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');},theme);
  const details=page.locator('details');assert.equal(await details.getAttribute('open'),null);
  await details.locator('summary').focus();await page.keyboard.press('Enter');assert.notEqual(await details.getAttribute('open'),null);await details.locator('summary').click();
  await page.screenshot({path:output+`${width}-${theme}.png`,fullPage:true});
  await confirm.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Check registration status'}).waitFor();assert.equal(posts,1);
  assert.equal(await confirm.count(),0);await page.getByRole('button',{name:'Check registration status'}).click();
  await page.getByRole('heading',{name:'Setup confirmed'}).waitFor();assert.equal(posts,1);assert.match(await page.getByLabel('Registration receipt').inputValue(),/fixture-trust/);
  await page.reload();await page.getByRole('heading',{name:'Setup confirmed'}).waitFor();assert.equal(posts,1);
  deny=true;await page.reload();await page.getByRole('alert').waitFor();assert.equal(await confirm.count(),0);assert.equal(await page.getByLabel('Registration receipt').count(),0);
  deny=false;unknown=false;setup=fixture();await page.reload();await confirm.click();await page.getByRole('heading',{name:'Setup confirmed'}).waitFor();assert.equal(posts,2);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Passed desktop/mobile light/dark, keyboard/tap details, no automatic POST, exact review, success, lost-response read-only reconcile, reload, owner denial, receipt and overflow. Synthetic only.');
} finally {await browser.close();await vite.close();}
