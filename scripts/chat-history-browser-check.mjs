import {HistoryPages} from '../server/src/runtime/historyPages.ts';
import {writeFile} from 'node:fs/promises';
// Full application fixtures; all APIs and chat WebSockets isolated from production.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 3299, strictPort: true },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const restricted=false;
const metrics=[];const store=new HistoryPages();
const output = new URL("../docs/reports/chat-history/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {
  for(const [mode,width,theme] of [['baseline',1440,'light'],... [320,375,414,768,1440].flatMap(width=>['light','dark'].map(theme=>['paged',width,theme]))]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 }, timezoneId: "UTC",
        reducedMotion: "reduce",
      });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.log("PAGE ERROR", e.stack);
      });
      const time = minutes => Date.parse('2026-09-23T00:00:00Z') + minutes*60000;
      const session = (id,minutes) => ({id,started_ms:time(minutes),connected_ms:time(minutes),duration_ms:65000,outcome:'ended'});
      let sessions = [];
      let heldEarlier;
      let org = {
          revision: 0,
          groups: [{ id: "support", name: "Customer Service" }],
          placements: { bot0: "support" },
          fallback: "Unassigned",
        },
        fail = false;
      const bots = Array.from({ length: 26 }, (_, i) => ({
        conversation_id: "bot" + i,
        name: i === 0 ? "Goldberg" : "Bot " + i,
        title: i === 0 ? "Accounting" : "Support",
        questions: i === 1 ? 2 : 0,
        state: "idle",
        unread: i === 0,
        updated_at: "2026-09-23",
        last_reply: {
          text:
            i === 0
              ? "Got it. Stopping until you say otherwise."
              : "The latest completed response with context for this item.",
          at: "2026-09-23",
        },
        membership: {
          subteam: i === 0 ? "Customer Service" : "",
          role: "specialist",
        },
      }));
      await page.addInitScript(() =>
        localStorage.setItem("veneer:selected-business", "team"),
      );
      await page.route("**/api/**", async (route) => {
        const req = route.request(),
          p = new URL(req.url()).pathname;
        let body = {};
        if (p === "/api/me")
          body = {
            setupRequired: false,
            pending: false,
            user: {
              id: 1,
              email: "fixture@example.test",
              displayName: "Alex",
              role: restricted ? "member" : "owner",
              employeeWorkspace: restricted,
            },
          };
        else if (p === "/api/bots")
          body = {
            bots,
            teams: [{ id: "team", name: "Fixture Business" }],
            decisions: [],
          };
        else if (p === "/api/bots/organization") {
          if (req.method() === "POST") {
            if (fail) {
              fail = false;
              return route.fulfill({
                status: 409,
                json: { error: "Organization changed. Reload and try again." },
              });
            }
            const b = req.postDataJSON();
            assert.equal(b.expected_revision, org.revision);
            org = { ...b.definition, revision: org.revision + 1 };
          }
          body = org;
        } else if (p === "/api/navigation")
          body = { configured: false, navigation: { items: [] } };
        else if (p === "/api/page-brand") body = { brand: {} };
        else if (p === "/api/huddles") body = { huddles: [] };
        else if (p === "/api/team-rooms") body = { rooms: [] };
        else if (p === "/api/team-rooms/directory")
          body = { self_key: "user:1", teams: [] };
        else if (p === "/api/projects") body = { projects: [] };
        else if (
          p === "/api/conversations" ||
          p === "/api/recent-conversations"
        )
          body = { conversations: [] };
        else if (/^\/api\/conversations\/bot\d+$/.test(p)) {
          const id = p.split("/").at(-1);
          body = {
            conversation: {
              id,
              title: "Goldberg",
              isBot: true,
              visibility: "team",
              canSend: true,
              canManage: true,
              canChangeVisibility: true,
              creator: { id: 1, displayName: "Alex" },
              model: null,
              effort: null,
              approvalMode: null,
              effectiveApprovalMode: "default",
              fullAccess: false,
              channel: "web",
              assistantSlug: "assistant",
              assistantName: "Assistant",
              projectId: null,
              originConversationId: null,
              archived: false,
              pinOrder: null,
              contextTokens: null,
              status: "idle",
              activity: null,
              unread: false,
              hasPendingWakeup: false,
              automation: null,
              provider: "claude",
              assistantId: 1,
              workspaceDir: "/fixture",
              businessTeamId: "team",
              botName: "Goldberg",
              createdAt: "2026-09-23",
              updatedAt: "2026-09-23",
            },
          };
        } else if (p === "/api/assistants")
          body = {
            assistants: [{ id: 1, name: "Assistant", slug: "assistant" }],
          };
        else if (p === "/api/models") body = { models: [] };
        else if (p.includes("/threads")) body = { threads: [] };
        else if (p === '/api/live-voice/sessions') {
          const url = new URL(req.url());
          if(url.searchParams.get('bot')==='bot1') body={sessions:[]};
          else if(url.searchParams.has('before_ms')) { heldEarlier=route; return; }
          else body={sessions:sessions.slice(0,50)};
        }
        else if (p.startsWith('/api/live-voice/sessions/')) body={entries:[{id:1,role:'user',text:'Fixture narration, private to this caller.',createdAt:'2026-09-23T09:17:23Z'}],next:null};
        else if (p.includes("/bot-communication/chats/"))
          body = { drafts: [], briefings: [] };
        else if (p.includes("/connectors")) body = { connectors: [] };
        else if (p.includes("/model-prefs")) body = { prefs: {} };
        else
          return route.fulfill({
            status: 404,
            json: { error: "Not present in fixture" },
          });
        await route.fulfill({ json: body });
      });
      const events=Array.from({length:2000},(_,i)=>[
        {type:'turn_started',turnId:`t${i}`,role:'user',text:`Review synthetic item ${i}`,at:new Date(Date.now()-86400000+i*40000).toISOString(),via:'web'},
        {type:'text_final',turnId:`t${i}`,markdown:`Result ${i}. `+'Synthetic context with no real customer data. '.repeat(30),at:new Date(Date.now()-86400000+i*40000+500).toISOString()},
        {type:'turn_done',turnId:`t${i}`}]).flat();
      const initial=mode==='paged'?store.open('bot0',events):{events,history:undefined};
      let socket;let historyRequests=0;
      await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(raw=>{
        const request=JSON.parse(String(raw));
        if(request.kind==='subscribe')ws.send(JSON.stringify({kind:'snapshot',conversationId:request.conversationId,status:'idle',queue:{revision:0,messages:[],failedTurn:null},wakeups:[],...initial}));
        if(request.kind==='history'){historyRequests++;ws.send(JSON.stringify({kind:'history',conversationId:request.conversationId,...store.page('bot0',request.token,request.before)}));}
      });});
      await page.goto("http://127.0.0.1:3299/#/chat/bot0");
      await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
      const composer=page.getByRole('textbox',{name:'Message',exact:true});
      await composer.waitFor();
      await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length>10);
      await page.waitForTimeout(500);
      const dom=await page.locator('[data-message-id]').count();
      const allNodes=await page.locator('*').count();
      const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
      const memory=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize')?.value;
      await composer.evaluate(el=>{window.__inputFrames=[];el.addEventListener('input',()=>{const t=performance.now();requestAnimationFrame(()=>window.__inputFrames.push(performance.now()-t));});});
      const latency=[];await composer.focus();
      for(const c of 'typing stays responsive'){
        const start=performance.now();await page.keyboard.type(c);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>r())));latency.push(performance.now()-start);
      }
      assert.equal(await composer.inputValue(),'typing stays responsive');
      latency.sort((a,b)=>a-b);
      const inputFrames=await page.evaluate(()=>window.__inputFrames.sort((a,b)=>a-b));
      metrics.push({inputToFrameMedianMs:inputFrames[Math.floor(inputFrames.length/2)],inputToFrameP95Ms:inputFrames[Math.floor(inputFrames.length*.95)],mode,width,theme,fixtureTurns:2000,snapshotBytes:Buffer.byteLength(JSON.stringify(initial)),domRows:dom,domNodes:allNodes,heapBytes:memory,keyToNextFrameMedianMs:latency[Math.floor(latency.length/2)],keyToNextFrameP95Ms:latency[Math.floor(latency.length*.95)]});
      if(mode==='paged'){
        assert(dom<500,'initial transcript is bounded');
        const before=await page.locator('[data-message-id]').count();
        const viewport=page.locator('[data-slot="message-scroller-viewport"]');
        await viewport.evaluate(el=>el.scrollTop=0);
        await page.waitForTimeout(150);
        if(!historyRequests)await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
        await page.waitForFunction(n=>document.querySelectorAll('[data-message-id]').length>n,before);
        assert.equal(await composer.inputValue(),'typing stays responsive');
        // Hold a selection in an unchanged result while prepending another page.
        const anchorRow=page.locator('[data-message-id]').filter({hasText:'Result 1999.'}).first();
        await anchorRow.evaluate(el=>el.scrollIntoView({block:'center'}));await page.waitForTimeout(200);
        const anchorY=(await anchorRow.boundingBox()).y;
        const selectionText=await page.locator('[data-message-id]').filter({hasText:'Result 1999.'}).first().evaluate(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(node.textContent.includes('Result 1999.')){const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(20,node.textContent.length));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();}return '';});
        await page.getByRole('button',{name:'Load earlier messages',exact:true}).evaluate(el=>el.click());await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>getSelection()?.toString()),selectionText);
        assert(Math.abs((await anchorRow.boundingBox()).y-anchorY)<32,'visible message anchor preserved while older page prepends');
        socket.send(JSON.stringify({kind:'event',conversationId:'bot0',event:{type:'text_final',turnId:'live',markdown:'Synthetic live result.',at:new Date().toISOString()}}));
        await page.getByText('Synthetic live result.',{exact:true}).waitFor();
        assert.equal(await composer.inputValue(),'typing stays responsive');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await viewport.evaluate(el=>el.scrollTop=el.scrollHeight);
        if([375,1440].includes(width))await page.screenshot({path:output+`history-${width}-${theme}.png`});
        const replacement=store.open('bot0',events);
        socket.send(JSON.stringify({kind:'snapshot',conversationId:'bot0',status:'idle',queue:{revision:0,messages:[],failedTurn:null},wakeups:[],...replacement}));
        await page.waitForTimeout(150);
        const freshCount=await page.locator('[data-message-id]').count();
        socket.send(JSON.stringify({kind:'history',conversationId:'bot0',...store.page('bot0',initial.history.token,initial.history.before)}));
        await page.waitForTimeout(100);
        assert.equal(await page.locator('[data-message-id]').count(),freshCount,'stale generation cannot prepend after reconnect');
        assert.equal(await composer.inputValue(),'typing stays responsive');
      }
      assert.deepEqual(errors,[]);await page.close();
    }
  await writeFile(output+'browser-metrics.json',JSON.stringify(metrics,null,2));
  console.log('Synthetic full-chat history checks passed: baseline/paged metrics, bounded initial DOM, older loading, selection, live result, composer draft, five widths and both themes.');
} finally {store.close();await browser.close();await vite.close();}
