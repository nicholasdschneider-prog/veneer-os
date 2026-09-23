import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url).pathname;
const vite = await createServer({ root: `${root}web`, server: { host:'127.0.0.1', port:3296, strictPort:true, fs:{allow:[root]} }, plugins:[{
 name:'decision-preview', configureServer(server) { server.middlewares.use('/decision-preview', async (_req,res) => { res.setHeader('Content-Type','text/html'); res.end(await server.transformIndexHtml('/decision-preview', `<html><body><div id="root"></div><script type="module" src="/@fs/${root}scripts/fixtures/decision-review.tsx"></script></body></html>`)); }); }
}] });
await vite.listen();
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=`${root}docs/reports/decision-review`;
await mkdir(output,{recursive:true});
try {
 for (const width of [320,375,414,768,1440]) for (const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.route('**/api/**',r=>r.fulfill({status:404,body:'Fixture only'}));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3296/decision-preview');
  await page.locator('h2').first().waitFor();
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.colorMode=t},theme);
  const card=page.locator('[data-case="not_verified"]');
  const background=card.getByRole('button',{name:'Background',exact:true});
  await background.hover();await card.getByRole('region',{name:'Background'}).waitFor();
  assert(await card.getByText('Written acceptance and a ship date remain unconfirmed.',{exact:true}).isVisible());
  await page.mouse.move(0,0);await background.focus();await page.keyboard.press('Enter');
  assert.equal(await background.getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');assert.equal(await background.getAttribute('aria-expanded'),'false');
  await background.click();assert.equal(await background.getAttribute('aria-expanded'),'true');
  await background.click();assert.equal(await background.getAttribute('aria-expanded'),'false');
  assert(await card.getByText('Not verified',{exact:true}).isVisible());
  for(const [status,label] of [['none','NO'],['partial','PARTIAL'],['full','YES']]) assert(await page.locator(`[data-case="${status}"]`).getByText(label,{exact:true}).isVisible());
  assert(await page.locator('[data-case="legacy"]').getByText('Not verified',{exact:true}).isVisible());
  const reply=card.getByRole('region',{name:'Proposed customer reply'});
  assert(await reply.isVisible());
  assert((await reply.boundingBox()).y < (await background.boundingBox()).y);
  assert.equal(await card.locator('details[open]').count(),0);
  await card.getByText('Original details & conditions',{exact:true}).click();
  assert(await card.getByText('Original question: Scott custom shades — $0 new action',{exact:true}).isVisible());
  await card.getByText('Original details & conditions',{exact:true}).click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  if ([375,1440].includes(width)) await page.screenshot({path:`${output}/${width}-${theme}.png`,fullPage:true});
  await page.close();
 }
 console.log('Decision review passed: five widths, both themes, reply first, hover/keyboard/tap/Escape background, raw details, refund full/partial/none/unknown and legacy/action-only. No live decisions.');
} finally { await browser.close();await vite.close(); }
