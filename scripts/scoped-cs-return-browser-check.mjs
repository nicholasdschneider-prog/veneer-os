// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';import {Bots} from '/src/screens/Bots.tsx';import {VoiceProvider} from '/src/components/VoiceProvider.tsx';import '/src/styles.css';window.navigation=[];ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(VoiceProvider,null,React.createElement('main',{style:{height:'100dvh'}},React.createElement(Bots,{decisionId:'fixture',onNavigate:hash=>window.navigation.push(hash)}))));`;
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: {
    host: "127.0.0.1",
    port: 3299,
    strictPort: true,
    preTransformRequests: false,
  },
  plugins: [
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use("/__fixture", async (req, res) => {
          res.setHeader(
            "Content-Type",
            req.url?.includes("entry") ? "application/javascript" : "text/html",
          );
          res.end(
            req.url?.includes("entry")
              ? source
              : await s.transformIndexHtml(
                  "/__fixture",
                  '<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>',
                ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const output = new URL("../docs/reports/scoped-cs-return/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const seed = await browser.newPage();
const png = Buffer.from(await seed.evaluate(() => { const c = document.createElement('canvas'); c.width=600;c.height=400;const x=c.getContext('2d');x.fillStyle='#e5e7eb';x.fillRect(0,0,600,400);x.fillStyle='#bf9d70';x.fillRect(90,100,420,220);x.strokeStyle='#694d2c';x.lineWidth=4;x.strokeRect(90,100,420,220);x.beginPath();x.moveTo(300,100);x.lineTo(280,160);x.lineTo(320,200);x.lineTo(300,320);x.stroke();x.fillStyle='#111827';x.font='24px sans-serif';x.fillText('TEST FIXTURE · Packaging photo',55,55);return c.toDataURL('image/png').split(',')[1];}), 'base64');
await seed.close();
const decision={image_access:['source_access','decision_context_only','source_access'],evidence_access:['decision_context_only'],id:'fixture',conversation_id:'bot0',version:1,state:'needs_input',bot_name:'Helper',assignee_name:'Alex',can_answer:true,can_amend:false,created_at:'2026-09-23T00:00:00Z',updated_at:'2026-09-23T00:00:00Z',answer:null,result:null,parked:null,proposal:{question:'Review the supplied packaging photos?',recommendation:'Review the customer’s photos before deciding.',consequence:'Proposed replacement $259.98. Preserve the unresolved return requirement. No customer message authorized.',blocked_action:'Wait for the exact decision.',blocks_scope:'task',evidence:[{conversation_id:'private-source',label:'Case-specific retained reference'}],deadline:null,team:'Support', images:[{conversation_id:'bot0',path:'/fixture/one.png',label:'Packaging condition',source:'Customer · fixture ticket'},{conversation_id:'bot0',path:'/fixture/two.png',label:'Second view — long caption preserves the supplied context without losing important details',source:'Bot · retained fixture original'},{conversation_id:'bot0',path:'/fixture/missing.png',label:'Unavailable photo',source:'Customer · retained file missing'}]}};
try { for (const width of [320,375,414,768,1080,1440,1920]) for (const theme of ['light','dark']) {
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));let mutations=0,restrictedLoads=0;
 await page.route('**/api/**',async route=>{if(route.request().method()!=='GET'){mutations++;return route.fulfill({status:403,json:{error:'Fixture forbids writes'}});}const p=new URL(route.request().url()).pathname;let body;
 if(p.includes('/images/')) {if(p.endsWith('/1'))restrictedLoads++;if(p.endsWith('/2'))return route.fulfill({status:404});if(p.endsWith('/1'))await new Promise(r=>setTimeout(r,200));return route.fulfill({contentType:'image/png',body:png});}
 if(p==='/api/bots')body={bots:[{conversation_id:'bot0',name:'Helper',title:'Helper',unread:false,role:'bot',pending_questions:1}],teams:[],decisions:[decision]};
 else if(p==='/api/bots/decisions/fixture')body={decision,messages:[],events:[]};
 else if(p==='/api/bots/organization')body={groups:[],placements:{},fallback:null,revision:0};
 else if(p==='/api/team-rooms')body={rooms:[]};else if(p==='/api/huddles')body={huddles:[]};else if(p.includes('briefing'))body={briefing:null};else if(p.includes('guide'))body={features:[],updated:'2026-09-23'};else return route.fulfill({status:404,json:{error:'Unavailable in fixture'}});return route.fulfill({json:body});});
 await page.goto('http://127.0.0.1:3299/__fixture');await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
 const gallery=page.getByRole('region',{name:'Images supplied for this decision'});await gallery.scrollIntoViewIfNeeded();
 const open=gallery.getByRole('button',{name:'Enlarge Packaging condition',exact:true});await open.focus();await page.waitForFunction(()=>document.querySelector('button[aria-label="Enlarge Packaging condition"]')?.disabled===false);await page.keyboard.press('Enter');
 const modal=page.getByRole('dialog');await modal.waitFor();const close=modal.getByRole('button',{name:'Close',exact:true});await close.hover();const closeBounds=await close.boundingBox();assert(closeBounds.width>=44 && closeBounds.height>=44);await modal.getByRole('button',{name:'View full size'}).click();await modal.getByRole('button',{name:'Fit image'}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(width===375||width===1440)await page.screenshot({path:output+`preview-${width}-${theme}.png`});
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Enlarge Packaging condition');
 await gallery.getByRole('button',{name:'Retry image'}).click();await gallery.getByText('Image unavailable or changed').waitFor();
 assert(await gallery.getByRole('button',{name:'Enlarge Unavailable photo'}).isDisabled());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(mutations,0);assert.equal(restrictedLoads,0);await gallery.getByText('Image not shared with your account.').waitFor();await page.getByText('Case history, evidence & details',{exact:false}).click();await page.getByText('Referenced source · restricted conversation.',{exact:false}).waitFor();assert.equal(await page.locator('a[href*=private-source]').count(),0);assert.deepEqual(errors,[]);
 await gallery.scrollIntoViewIfNeeded();await page.screenshot({path:output+`gallery-${width}-${theme}.png`});await page.close();console.log('PASS',width,theme);
 }}finally{await browser.close();await vite.close();}
