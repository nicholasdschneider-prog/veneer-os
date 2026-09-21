// Drop hashed bundles in web/dist/assets that no build has written for a
// while. Vite keeps old bundles (build.emptyOutDir=false) so a browser holding
// a pre-deploy index.html can still load what it references; without this
// sweep the directory would grow with every build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist/assets');
const current = new Set();
try {
  const html = fs.readFileSync(path.join(assets, '..', 'index.html'), 'utf8');
  for (const m of html.matchAll(/\/assets\/([^"']+)/g)) current.add(m[1]);
} catch {
  process.exit(0);
}
if (!fs.existsSync(assets)) process.exit(0);
const cutoff = Date.now() - KEEP_MS;
let removed = 0;
for (const name of fs.readdirSync(assets)) {
  if (current.has(name)) continue;
  const file = path.join(assets, name);
  const stat = fs.statSync(file);
  if (stat.isFile() && stat.mtimeMs < cutoff) {
    fs.unlinkSync(file);
    removed++;
  }
}
if (removed) console.log(`[prune-web-assets] removed ${removed} stale bundle file(s)`);
