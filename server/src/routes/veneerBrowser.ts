import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { lanViewerPageUrl } from '../channels/lanViewer.js';
import {
  VENEER_BROWSER_QUALITY_MAX,
  VENEER_BROWSER_QUALITY_MIN,
  VENEER_BROWSER_RESOLUTIONS,
  readVeneerBrowserSettings,
  writeVeneerBrowserSettings,
} from '../veneerBrowser/settings.js';

const NameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const ConversationCreateSchema = NameSchema;
const DeleteSchema = z.object({ confirm: z.literal(true) });
const SelectSchema = z.object({ profileId: z.string().min(1).max(200) });
const CaptureSchema = z.object({ active: z.boolean() });
const BrowserSettingsSchema = z.object({
  quality: z.number().int().min(VENEER_BROWSER_QUALITY_MIN).max(VENEER_BROWSER_QUALITY_MAX),
  resolution: z.enum(VENEER_BROWSER_RESOLUTIONS),
});

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/not found|not configured|active browser|browser limit|requires a chat|in use|another profile|already has|temporary browser|browser cop|saved profile|working copy|signed-out|advanced capture/i.test(message)) return message;
  return 'Veneer Browser is temporarily unavailable.';
}

export function createVeneerBrowserRouter(ctx: AppContext): Router {
  const router = express.Router();

  router.get('/settings', (_req, res) => {
    res.json({ ok: true, settings: readVeneerBrowserSettings(ctx.db) });
  });

  router.put('/settings', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const body = BrowserSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Choose a supported browser quality and resolution.' });
      return;
    }
    res.json({ ok: true, settings: writeVeneerBrowserSettings(ctx.db, body.data) });
  });

  router.get('/projects/:projectId/profiles', (req, res) => {
    void ctx.manager.veneerBrowserProfiles(req.user!.id, req.user!.role, req.params.projectId)
      .then((result) => res.json({ ok: true, ...result }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.post('/projects/:projectId/profiles', (req, res) => {
    const body = NameSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Enter a profile name.' });
    void ctx.manager.veneerBrowserCreate(req.user!.id, req.params.projectId, body.data.name)
      .then((profile) => res.status(201).json({ ok: true, profile }))
      .catch((error) => res.status(503).json({ ok: false, error: safeError(error) }));
  });

  router.put('/projects/:projectId/default', (req, res) => {
    const body = SelectSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Select a browser profile.' });
    void ctx.manager.veneerBrowserSetDefault(req.user!.id, req.params.projectId, body.data.profileId)
      .then(() => res.json({ ok: true }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.patch('/projects/:projectId/profiles/:profileId', (req, res) => {
    const body = NameSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Enter a profile name.' });
    void ctx.manager.veneerBrowserRename(req.user!.id, req.params.projectId, req.params.profileId, body.data.name)
      .then((profile) => res.json({ ok: true, profile }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.delete('/projects/:projectId/profiles/:profileId', (req, res) => {
    if (!DeleteSchema.safeParse(req.body).success) {
      res.status(400).json({ ok: false, error: 'Confirm profile deletion.' });
      return;
    }
    void ctx.manager.veneerBrowserDelete(req.user!.id, req.user!.role, req.params.projectId, req.params.profileId)
      .then(() => res.json({ ok: true }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  router.post('/projects/:projectId/profiles/:profileId/stop', (req, res) => {
    void ctx.manager.veneerBrowserStop(req.user!.id, req.params.projectId, req.params.profileId)
      .then((profile) => res.json({ ok: true, profile }))
      .catch((error) => res.status(503).json({ ok: false, error: safeError(error) }));
  });

  router.get('/projects/:projectId/profiles/:profileId/status', (req, res) => {
    void ctx.manager.veneerBrowserStatus(req.user!.id, req.params.projectId, req.params.profileId)
      .then((profile) => res.json({ ok: true, profile }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.get('/conversations/:conversationId', (req, res) => {
    void ctx.manager.veneerBrowserConversation(req.user!.id, req.params.conversationId)
      .then((session) => res.json({ ok: true, session }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.get('/conversations/:conversationId/profiles', (req, res) => {
    void ctx.manager.veneerBrowserConversationProfiles(req.user!.id, req.params.conversationId)
      .then((profiles) => res.json({ ok: true, profiles }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.post('/conversations/:conversationId/profiles', (req, res) => {
    const body = ConversationCreateSchema.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Enter a profile name.' });
    void ctx.manager.veneerBrowserConversationCreate(req.user!.id, req.params.conversationId, body.data.name)
      .then((session) => res.status(201).json({ ok: true, session }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  router.put('/conversations/:conversationId/profile', (req, res) => {
    const body = SelectSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Select a browser profile.' });
    void ctx.manager.veneerBrowserConversationSelect(
      req.user!.id, req.params.conversationId, body.data.profileId,
    ).then((session) => res.json({ ok: true, session }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  router.post('/conversations/:conversationId/fresh', (req, res) => {
    void ctx.manager.veneerBrowserConversationFresh(req.user!.id, req.params.conversationId)
      .then((session) => res.json({ ok: true, session }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  router.post('/conversations/:conversationId/update-profile', (req, res) => {
    void ctx.manager.veneerBrowserConversationUpdateProfile(req.user!.id, req.params.conversationId)
      .then((session) => res.json({ ok: true, session }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  router.post('/conversations/:conversationId/save-as', (req, res) => {
    const body = NameSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Enter a profile name.' });
    void ctx.manager.veneerBrowserConversationSaveAs(req.user!.id, req.params.conversationId, body.data.name)
      .then((session) => res.status(201).json({ ok: true, session }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  // Advanced capture unlocks network inspection on the signed-in browser, so it
  // is settable only here — by the authenticated user, for one chat. The agent's
  // MCP server deliberately exposes no tool that reaches this.
  router.get('/conversations/:conversationId/capture', (req, res) => {
    void ctx.manager.veneerBrowserConversationCaptureGet(req.user!.id, req.params.conversationId)
      .then((capture) => res.json({ ok: true, capture }))
      .catch((error) => res.status(404).json({ ok: false, error: safeError(error) }));
  });

  router.put('/conversations/:conversationId/capture', (req, res) => {
    const body = CaptureSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ ok: false, error: 'Choose whether Advanced capture is on or off.' });
    void ctx.manager.veneerBrowserConversationCaptureSet(req.user!.id, req.params.conversationId, body.data.active)
      .then((capture) => res.json({ ok: true, capture }))
      .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
  });

  // A one-minute, single-use ticket that loads the viewer page from this
  // machine's LAN listener instead of the tunnel. 404 when this host has no
  // LAN listener, so the panel just keeps embedding the tunnel page.
  router.post('/conversations/:conversationId/lan-viewer', (req, res) => {
    const store = ctx.viewerTickets;
    const lan = ctx.config.lanViewer;
    if (!store || !lan) return void res.status(404).json({ ok: false, error: 'No LAN viewer on this host.' });
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0]!.trim() === 'http' ? 'http' : 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim().replace(/[^A-Za-z0-9.:-]/g, '');
    if (!host) return void res.status(400).json({ ok: false, error: 'Unknown app origin.' });
    const token = store.issue(req.user!.id, req.params.conversationId, `${proto}://${host}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, viewerUrl: lanViewerPageUrl(lan, token) });
  });

  for (const action of ['open', 'stop'] as const) {
    router.post(`/conversations/:conversationId/${action}`, (req, res) => {
      const operation = action === 'open'
        ? ctx.manager.veneerBrowserConversationOpen
        : ctx.manager.veneerBrowserConversationStop;
      void operation(req.user!.id, req.params.conversationId)
        .then((session) => res.json({ ok: true, session }))
        .catch((error) => res.status(409).json({ ok: false, error: safeError(error) }));
    });
  }

  return router;
}
