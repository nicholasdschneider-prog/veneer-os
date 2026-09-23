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
const restricted = process.env.CHAT_FIXTURE_RESTRICTED === "1";
const output = new URL("../docs/reports/voice-timeline/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {
  for (const width of (restricted ? [375, 1280] : [320, 375, 414, 768, 1440]))
    for (const theme of ["light", "dark"]) {
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
      let sessions = [session('afternoon',948),session('morning',557),...Array.from({length:48},(_,i)=>session('older'+i,490+i))].sort((a,b)=>b.started_ms-a.started_ms);
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
      await page.routeWebSocket("**/ws", (ws) =>
        ws.onMessage((raw) => {
          const p = JSON.parse(String(raw));
          if (p.kind === "subscribe")
            ws.send(
              JSON.stringify({
                kind: "snapshot",
                conversationId: p.conversationId,
                status: "idle",
                queue: { revision: 0, messages: [], failedTurn: null },
                wakeups: [],
                events: Array.from({ length: 35 }, (_, i) => [
                  {
                    type: "turn_started",
                    turnId: "t" + i,
                    role: "user",
                    text: "Review fixture item " + i,
                    at: new Date(time(480+i*15)).toISOString(),
                    via: "web",
                  },
                  {
                    type: "text_final",
                    turnId: "t" + i,
                    markdown:
                      "The requested review is complete. This is a fixture response with enough detail to check message layout and scrolling.\n\nThe proposed next step remains subject to the existing approval process.",
                    at: new Date(time(481+i*15)).toISOString(),
                  },
                ]).flat(),
              }),
            );
        }),
      );
      await page.goto("http://127.0.0.1:3299/#/chat/bot0");
      await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
      await page.getByRole('button',{name:/Voice chat/}).first().waitFor();
      const cards=page.getByRole('button',{name:/Voice chat/});
      assert.equal(await cards.count(),50);
      // Compare DOM order, including frozen blocks, not just dates within a call list.
      const ordered=await page.locator('[data-slot="message-scroller-content"]').evaluate(el=>[...el.querySelectorAll('[data-message-id],button')].filter(e=>e.hasAttribute('data-message-id')||e.textContent.includes('Voice chat')).map(e=>e.textContent));
      const morningIndex=ordered.findIndex(t=>t.includes('Voice chat')&&t.includes('9:17'));
      const afternoonIndex=ordered.findIndex(t=>t.includes('Voice chat')&&t.includes('3:48'));
      assert(morningIndex>=0&&afternoonIndex>morningIndex);
      assert(ordered.slice(morningIndex+1,afternoonIndex).some(t=>t.includes('Review fixture item')));
      assert(ordered.slice(afternoonIndex+1).some(t=>t.includes('Review fixture item')));
      const morning=cards.filter({hasText:'9:17'});
      await morning.scrollIntoViewIfNeeded();await morning.focus();await page.keyboard.press('Enter');
      await page.getByText('Fixture narration, private to this caller.').waitFor();
      assert.match(await page.getByRole('dialog').innerText(),/Audio was not recorded/);
      await page.keyboard.press('Escape');
      sessions=[session('new-call',962),...sessions];
      await page.evaluate(()=>window.dispatchEvent(new Event('voice-session-ended')));
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(e=>e.textContent.includes('Voice chat')).length===51);
      const afternoon=cards.filter({hasText:'3:48'});await afternoon.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);await afternoon.evaluate(el=>el.scrollIntoView({block:'center'}));await page.waitForTimeout(250);
      const cardBox=await afternoon.boundingBox();assert(cardBox&&cardBox.y>0&&cardBox.y+cardBox.height<1000,'call remains visible after layout settles');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:output+`timeline-${width}-${theme}.png`});
      // An older-page response arriving after a chat switch must never bleed into it.
      await page.getByRole('button',{name:'Earlier voice chats',exact:true}).click();
      await page.waitForTimeout(50);
      await page.evaluate(()=>location.hash='#/chat/bot1');
      await page.waitForTimeout(100);
      if(heldEarlier) await heldEarlier.fulfill({json:{sessions:[session('earliest',470)]}});
      await page.waitForTimeout(100);assert.equal(await cards.count(),0);
      await page.evaluate(()=>location.hash='#/chat/bot0');
      await cards.first().waitFor();assert.equal(await cards.count(),50);
      await page.getByRole('button',{name:'Earlier voice chats',exact:true}).click();
      await page.waitForTimeout(50);await heldEarlier.fulfill({json:{sessions:[sessions.at(-1),session('earliest',470)]}});
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(e=>e.textContent.includes('Voice chat')).length===52);
      assert.equal(await page.getByRole('button',{name:'Earlier voice chats',exact:true}).count(),0);
      assert.deepEqual(errors,[]);await page.close();
    }
  console.log('Passed chronological frozen/live timeline, refresh, transcript keyboard access, earlier pages, stale chat-switch response, themes and mobile/desktop overflow. No live APIs or calls.');
} finally {await browser.close();await vite.close();}
