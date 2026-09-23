// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';import {Bots} from '/src/screens/Bots.tsx';import {VoiceProvider} from '/src/components/VoiceProvider.tsx';import '/src/styles.css';window.navigation=[];ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(VoiceProvider,null,React.createElement('main',{style:{height:'100dvh'}},React.createElement(Bots,{onNavigate:hash=>window.navigation.push(hash)}))));`;
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
const output = new URL("../docs/reports/raised-hands/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const decision={id:'fixture',conversation_id:'bot0',version:1,state:'needs_input',bot_name:'Helper',assignee_name:'Alex',can_answer:true,can_amend:false,created_at:'2026-09-23T00:00:00Z',updated_at:'2026-09-23T00:00:00Z',answer:null,result:null,parked:null,proposal:{question:'Refund the $259.98 price difference?',recommendation:'Review the new evidence before approving the refund.',consequence:'Refund $259.98 to the original payment method. Preserve all material limits and uncertainty.',blocked_action:'Wait for the exact decision.',blocks_scope:'task',evidence:[],deadline:null,team:'Support'} };
try{for(const width of [320,375,414,768,1080,1280,1440,1920])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));let mutations=0;
 await page.addInitScript(()=>localStorage.setItem('veneer:selected-business','team'));
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let body={};if(route.request().method()!=='GET'){mutations++;return route.fulfill({status:400,json:{error:'No mutations permitted'}});}if(p==='/api/bots')body={bots:Array.from({length:35},(_,i)=>({conversation_id:'bot'+i,name:'Helper '+i,questions:i?0:1,state:'idle',unread:false})),teams:[{id:'team',name:'Fixture Business'}],decisions:[{...decision,id:'blocked-fixture',state:'blocked',answer:{action:'approve'},can_answer:false},decision,{...decision,id:'draft',proposal:{...decision.proposal,blocked_action:'Wait for approval. EXACT DRAFT: We have reviewed the evidence; the proposed refund is $259.98.'}}]};else if(p==='/api/bots/organization')body={groups:[],placements:{},fallback:null,revision:0};else if(p==='/api/team-rooms')body={rooms:[]};else if(p==='/api/huddles')body={huddles:[]};else if(p.includes('briefing'))body={briefing:null};else if(p.includes('guide'))body={features:[],updated:'2026-09-23'};else return route.fulfill({status:404,json:{error:'Unavailable in fixture'}});await route.fulfill({json:body});});
 await page.goto('http://127.0.0.1:3299/__fixture');await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
 const progress=page.getByLabel('Progress & history',{exact:true});
 await page.locator('#raised-hands').waitFor();
 assert.equal(await page.getByRole('button',{name:/Needs attention/}).count(),0);
 assert.equal(await progress.getAttribute('open'),null);
 await progress.locator(':scope > summary').click();await page.locator('article[data-decision-id="blocked-fixture"]').waitFor();
 await progress.locator(':scope > summary').click();
 const card=page.locator('article[data-decision-id="fixture"]');await card.getByRole('button',{name:'Review & decide',exact:true}).waitFor();
 const check=async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await card.boundingBox();for(const button of await card.getByRole('button').all()){if(!await button.isVisible())continue;const b=await button.boundingBox();assert(b.x>=box.x-1&&b.x+b.width<=box.x+box.width+1,'Action outside card');}};
 const draftCard=page.locator('article[data-decision-id="draft"]');
 await draftCard.getByRole('button',{name:'Approve & send reply',exact:true}).click();
 const draftBox=await draftCard.boundingBox();for(const button of await draftCard.getByRole('button').all()){if(!await button.isVisible())continue;const b=await button.boundingBox();assert(b.x>=draftBox.x-1&&b.x+b.width<=draftBox.x+draftBox.width+1);}
 await draftCard.getByRole('button',{name:'Cancel',exact:true}).click();
 await check();await card.getByRole('button',{name:'Approve as proposed',exact:true}).click();await card.getByRole('button',{name:'Cancel',exact:true}).waitFor();await check();await card.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(mutations,0);
 if(width>=768){const rail=page.getByRole('complementary',{name:'Chats'}).first();const overview=rail.getByRole('button',{name:/Bot work overview/});const before=await overview.boundingBox();const search=await rail.getByRole('textbox').boundingBox();assert(before.y>=search.y+search.height);await rail.locator('nav').evaluate(el=>el.scrollTop=el.scrollHeight);assert.equal((await overview.boundingBox()).y,before.y);await overview.click();assert.equal(await page.evaluate(()=>window.navigation.at(-1)),'#/bots?view=work');await rail.locator('nav').evaluate(el=>el.scrollTop=0);}
 await page.screenshot({path:output+`overview-${width}-${theme}.png`});
 if(width>=1080){await page.locator('[aria-label="Decision queues"]').evaluate(el=>{el.style.maxWidth='500px';});await page.waitForTimeout(100);await check();}
 assert.deepEqual(errors,[]);await page.close();console.log('PASS',width,theme);
}}finally{await browser.close();await vite.close();}
