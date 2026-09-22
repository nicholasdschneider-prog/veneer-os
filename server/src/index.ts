import { createBotEventsWebhook } from './botWorkflows/routes.js';
import { startBotWorkflows } from './botWorkflows/background.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadEnvFile } from './envFile.js';
import { loadConfig, warnIfDevIdentity } from './config.js';
import { migrateClaudeConfigFile } from './homes.js';
import { openDb } from './db/db.js';
import {
  createIdentityResolver,
  type Identity,
  type IdentityResolver,
} from './identity/cloudflareAccess.js';
import { resolveAgentTokenContext } from './runtime/agentTokens.js';
import { initMediaStore } from './runtime/media.js';
import { createRunnerClient } from './runner/client.js';
import { ensureFileSyncBackfill, syncConversationFiles } from './files/generatedFiles.js';
import { createApiRouter } from './routes/api.js';
import { createComposioWebhookRouter } from './routes/composioWebhook.js';
import { createAutoshipVerifierRouter } from './bots/verifierRoutes.js';
import { attachWebSocket } from './channels/webSocket.js';
import { attachSpeechToText } from './channels/speechToText.js';
import { attachTerminal } from './channels/terminal.js';
import { attachDesktop } from './channels/desktop.js';
import { attachCdpDesktop } from './channels/cdpDesktop.js';
import { attachLanViewer, createViewerTicketStore } from './channels/lanViewer.js';
import { attachVeneerBrowser } from './channels/veneerBrowser.js';
import { desktopWrapperHtml } from './routes/desktopPage.js';
import { cdpDesktopPageHtml } from './routes/cdpDesktopPage.js';
import { createSecretStore } from './secrets/store.js';
import { createClaudeConnectManager } from './claude/setupToken.js';
import { adoptCodexLogin, adoptCodexLogins, createCodexAccountStore } from './codex/accounts.js';
import { createCodexConnectManager } from './codex/deviceAuth.js';
import { createGrokConnectManager } from './grok/deviceAuth.js';
import { createCodexAccountUsage } from './usage/codex.js';
import { createGrokUsageReader } from './usage/grok.js';
import { createOpenRouterUsageReader } from './usage/openrouter.js';
import { effectiveApiKey } from './secrets/apiKeys.js';
import type { AppContext } from './context.js';
import { createLocalAppRunnerClient } from './miniApps/localClient.js';
import { createLocalMiniAppsRouter } from './routes/localMiniApps.js';
import { createShutdown } from './shutdown.js';
import { writePidFile } from './servicePid.js';
import { createDopplerTokenStore, DopplerRuntime } from './secrets/doppler.js';
import { enableProjectDopplerCli } from './secrets/projectDopplerCli.js';
import { startPageExpiry } from './pages/expiry.js';
import { applyPagesPublishingConfig } from './routes/pagesConfig.js';
import { refreshMiniAppWrappers } from './miniApps/wrapperUpgrade.js';
import { createSupermemoryProvisioner } from './memory/provision.js';
import { LiveVoiceService } from './voice/service.js';

// Before config: launchd cannot inject an env file, so the service reads it.
loadEnvFile();
// Web hosts the provider sign-in flows, which also pin CLAUDE_CONFIG_DIR, so it
// carries an existing install's `.claude.json` forward too. Race-safe and
// idempotent, so it does not matter which service boots first.
try {
  migrateClaudeConfigFile();
} catch (err) {
  console.warn(`[veneer-pro] could not carry .claude.json forward: ${(err as Error).message}`);
}
const config = loadConfig();
warnIfDevIdentity(config);
const db = openDb(config.dataDir);
// Tool-result images (screenshots etc.) land here; served at GET /api/media/:id.
initMediaStore(config.dataDir);

const secrets = createSecretStore(config.dataDir);
const dopplerTokens = createDopplerTokenStore(config.dataDir);
const doppler = new DopplerRuntime(dopplerTokens);
await doppler.refresh();
doppler.start();
// Same idempotent wrapper the runner builds; web needs it to write the secret
// a user types into a secret card. Env copy: web's own PATH stays untouched.
const projectDopplerCli = enableProjectDopplerCli(config.dataDir, { ...process.env });
applyPagesPublishingConfig(config, doppler);
const dopplerAppsToken = doppler.get('VP_APPS_CF_API_TOKEN');
if (config.miniAppsBase && dopplerAppsToken) {
  config.miniApps = { ...config.miniAppsBase, apiToken: dopplerAppsToken };
}
if (config.miniApps) {
  try {
    const refresh = await refreshMiniAppWrappers(db, config.miniApps);
    if (refresh.updated > 0) console.log(`[mini-apps] refreshed ${refresh.updated} platform wrapper(s)`);
    if (refresh.failed > 0) console.warn(`[mini-apps] ${refresh.failed} platform wrapper refresh(es) will retry next boot`);
  } catch (error) {
    console.warn(`[mini-apps] platform wrapper refresh skipped: ${(error as Error).message}`);
  }
}
// All agent-turn execution (adapters + conversation manager + usage writer)
// lives in the runner process now; web drives it over IPC. This client is the
// only turn surface web holds — it constructs no manager, adapters, or usage
// store. Restarting web never touches the runner, so in-flight turns survive.
const manager = createRunnerClient({
  baseUrl: `http://127.0.0.1:${config.runnerPort}`,
  dataDir: config.dataDir,
});
const appRunner = createLocalAppRunnerClient(`http://127.0.0.1:${config.appRunnerPort}`);
const claudeConnect = createClaudeConnectManager({ claudeBin: config.claudeBin, secrets });
// Several Codex accounts, each its own CODEX_HOME; sign-ins run in a staging
// home and are adopted into the registry on success (see codex/accounts.ts).
const codexAccounts = createCodexAccountStore(config.dataDir);
adoptCodexLogins(codexAccounts);
const codexConnect = createCodexConnectManager({
  codexBin: config.codexBin,
  onSuccess: (stagingHome) => adoptCodexLogin(codexAccounts, stagingHome),
  onDiscard: (stagingHome) => fs.rmSync(stagingHome, { recursive: true, force: true }),
});
const grokConnect = createGrokConnectManager({ grokBin: config.grokBin });
const codexUsage = createCodexAccountUsage({ codexBin: config.codexBin, accounts: codexAccounts });
const grokUsage = createGrokUsageReader();
const openRouterUsage = createOpenRouterUsageReader({
  getApiKey: () => effectiveApiKey('openrouter', secrets, config, doppler).value,
});
const memoryProvisioner = createSupermemoryProvisioner({
  dataDir: config.dataDir,
  getOpenRouterApiKey: () => effectiveApiKey('openrouter', secrets, config, doppler).value,
});
memoryProvisioner.start();
const baseResolveIdentity = createIdentityResolver(config);
// An agent's own tool calls (read_conversation/send_message — see
// runtime/agentTokens.ts) authenticate with a per-turn token instead of a
// human identity. A valid token resolves to the token-holder's email exactly
// like a verified human identity would, so every downstream authorization
// check (member/owner/consultant scoping) applies unchanged.
const resolveIdentity: IdentityResolver = async (req) => {
  const agentToken = String(req.headers['x-vp-agent-token'] ?? '').trim();
  if (agentToken) {
    const tokenCtx = resolveAgentTokenContext(db, agentToken);
    if (!tokenCtx) return null;
    return {
      email: tokenCtx.email,
      agentConversationId: tokenCtx.conversationId ?? undefined,
    } satisfies Identity;
  }
  return baseResolveIdentity(req);
};

const ctx: AppContext = {
  config,
  db,
  manager,
  resolveIdentity,
  secrets,
  dopplerTokens,
  doppler,
  projectDopplerCli,
  claudeConnect,
  codexConnect,
  codexAccounts,
  grokConnect,
  codexUsage,
  grokUsage,
  openRouterUsage,
  memoryProvisioner,
  appRunner,
};
const pageExpiry = startPageExpiry(ctx);
ctx.pageExpiry = pageExpiry;
ctx.liveVoice = new LiveVoiceService(ctx);

// Keeps the Files page fresh without polling: when a turn finishes, re-scan that
// chat's transcript and mirror any new deliverables into the durable registry
// (files/generatedFiles.ts). The background sweep (also fired by the list
// route) is the catch-up path for anything missed while web was down.
ctx.manager.bus.on('event', (conversationId: string, event: { type?: string }) => {
  if (event?.type !== 'turn_done') return;
  void syncConversationFiles(ctx, conversationId).catch((err: Error) =>
    console.warn('[generated-files] sync failed:', err.message),
  );
});
// Drain any sweep backlog shortly after boot (delayed so the runner's IPC is
// up) instead of waiting for someone to open the Files page.
setTimeout(() => void ensureFileSyncBackfill(ctx), 10_000).unref?.();

const app = express();
app.disable('x-powered-by');
app.use('/webhooks/bot-events', createBotEventsWebhook(ctx));
const stopBotWorkflows = startBotWorkflows(ctx);
app.get('/healthz', async (_req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:${config.runnerPort}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`runner returned ${response.status}`);
    res.json({ ok: true, web: 'healthy', runner: 'healthy' });
  } catch (error) {
    res.status(503).json({ ok: false, web: 'healthy', runner: 'unavailable', error: (error as Error).message });
  }
});
// Provider ingress is public by design and authenticates with Composio's HMAC
// signature, not a human Cloudflare Access identity.
app.use('/webhooks/composio', createComposioWebhookRouter(ctx));
// AutoShip verifier (option A): its own Cloudflare Access application and
// service identity, mounted ahead of the human /api identity gate so the
// service JWT is accepted here and nowhere else. Disabled (404) unless configured.
app.use('/api/autoship/verifier', createAutoshipVerifierRouter({ db, config }));
app.use('/api', createApiRouter(ctx));
// Cloudflare-runtime apps are intercepted at the edge. Local-runtime apps have
// no Worker route, fall through the tunnel, and are authenticated + proxied here.
app.use('/tools', createLocalMiniAppsRouter(ctx));

// VM Desktop. In 'cdp' mode this is a canvas viewer fed by a CDP screencast of
// the shared Chrome — no display server, so it works on macOS too. In 'vnc' mode
// it is the noVNC wrapper bridging to the loopback x11vnc. Registered BEFORE the
// SPA fallback below (its lookahead does not exclude /desktop). Access control
// lives on the WebSocket upgrade + the grant API; the static assets are behind
// CF Access like the rest of the site.
const desktopCdp = config.desktopMode === 'cdp';
app.get('/desktop', (_req, res) => res.type('html').send(desktopCdp ? cdpDesktopPageHtml() : desktopWrapperHtml()));
app.get('/veneer-browser', (req, res) => {
  const conversation = typeof req.query.conversation === 'string' ? req.query.conversation : '';
  const websocketPath = `/ws/veneer-browser?conversation=${encodeURIComponent(conversation)}`;
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(cdpDesktopPageHtml({
    websocketPath,
    title: 'Veneer Browser',
    subtitle: 'This chat browser',
    reportViewerHints: true,
  }));
});
if (!desktopCdp) {
  // The apt noVNC package has no index.html, so we always reference vnc.html.
  app.use('/desktop/novnc', express.static('/usr/share/novnc'));
}

// Static web build (production): server serves web/dist with SPA fallback.
// Hashed bundles under /assets are immutable, so they get a long cache life
// and a real 404 when missing. Answering a missing bundle with index.html
// (the old catch-all behavior) made a browser holding a pre-deploy shell
// receive HTML in place of its stylesheet or module, which renders the app
// unstyled instead of failing in a way it can recover from.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(webDist)) {
  const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache');
  app.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.all('/assets/*', (_req, res) => res.status(404).type('text').send('Not found'));
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders: (res, file) => {
        if (file.endsWith('.html') || file.endsWith('sw.js') || file.endsWith('.webmanifest')) noStore(res);
      },
    }),
  );
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) => {
    noStore(res);
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

const server = http.createServer(app);
attachWebSocket(server, ctx);
attachSpeechToText(server, ctx);
const terminals = attachTerminal(server, ctx);
if (desktopCdp) attachCdpDesktop(server, ctx);
else attachDesktop(server, ctx);
attachVeneerBrowser(server, ctx);
if (config.lanViewer) {
  ctx.viewerTickets = createViewerTicketStore();
  attachLanViewer(ctx, config.lanViewer, ctx.viewerTickets);
}

const clearPidFile = writePidFile(config.dataDir, 'veneer-pro');

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[veneer-pro] listening on http://127.0.0.1:${config.port} (identity: ${config.identity}, data: ${config.dataDir})`);
  // The runner owns turn execution and resumes interrupted turns at its own boot
  // — web no longer touches that path.
});

// Clean shutdown: drain in-flight HTTP, kill the login-flow child processes,
// close the runner client + DB, exit 0 for the supervisor to respawn. Idempotent
// — a restart tap and a SIGTERM racing can't double-close. Web shutdown does NOT
// kill agents: turns run in the runner and survive. Pending approvals are DB rows
// and survive.
const shutdown = createShutdown({
  name: 'veneer-pro',
  server,
  release: () => {
    ctx.liveVoice?.close();
    manager.close();
    terminals.shutdown();
    claudeConnect.shutdown();
    codexConnect.shutdown();
    grokConnect.shutdown();
    codexUsage.shutdown();
    stopBotWorkflows();
    doppler.stop();
    memoryProvisioner.stop();
      pageExpiry.close();
    clearPidFile();
    db.close();
  },
});

// Restart from the UI ("unstick"): with the web/runner split, stuck work lives
// in the RUNNER (it owns the agent child processes), so the admin button cycles
// the runner, not web — the UI stays connected. The runner drains, kills its
// in-flight turns, exits 0, and its supervisor respawns it; it resumes any
// pending_turns at the next boot. Fire-and-forget after the route has flushed
// its 202.
ctx.requestRestart = () => {
  setTimeout(() => {
    void manager.restart().catch((err: Error) => {
      console.error(`[veneer-pro] runner restart failed: ${err.message}`);
    });
  }, 150);
};

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown.drainAndExit(sig));
}
