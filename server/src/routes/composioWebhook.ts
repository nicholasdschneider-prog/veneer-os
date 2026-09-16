import express, { type Router } from 'express';
import type { AppContext } from '../context.js';
import { triggerRecipe } from '../automations/recipes.js';
import { parseComposioWebhook } from '../connectors/composio.js';
import type { ComposioInstallConfig } from '../connectors/catalog.js';
import type { ScheduledTaskRow, UserConnectorRow } from '../db/db.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';

const MAX_NORMALIZED_EVENT_BYTES = 32 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Public, signature-authenticated ingress. This deliberately sits outside the
 * /api Cloudflare identity gate; Cloudflare Access must bypass only this path.
 */
export function createComposioWebhookRouter(ctx: AppContext): Router {
  const router = express.Router();
  router.post(
    '/',
    express.raw({ type: 'application/json', limit: '256kb' }),
    (req, res) => {
      const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
      const secret = ctx.config.composioWebhookSecret;
      if (!apiKey || !secret) {
        res.status(503).json({ ok: false, error: 'Webhook ingress is not configured' });
        return;
      }
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ ok: false, error: 'Expected an application/json body' });
        return;
      }

      void parseComposioWebhook(apiKey, req.body, req.headers, secret)
        .then((result) => {
          const raw = record(result.rawPayload);
          if (raw?.type !== 'composio.trigger.message') {
            res.status(202).json({ ok: true });
            return;
          }
          const event = result.payload;
          const task = ctx.db
            .prepare(
              `SELECT * FROM scheduled_tasks
               WHERE external_trigger_id = ? AND trigger_kind = 'event'`,
            )
            .get(event.id) as ScheduledTaskRow | undefined;
          if (!task || !task.trigger_recipe || !task.connector_id) {
            // A deleted/rotated trigger can still have an in-flight delivery.
            res.status(202).json({ ok: true });
            return;
          }
          const connector = ctx.db
            .prepare("SELECT * FROM user_connectors WHERE id = ? AND status = 'connected'")
            .get(task.connector_id) as UserConnectorRow | undefined;
          if (!connector) {
            res.status(202).json({ ok: true });
            return;
          }
          let install: ComposioInstallConfig;
          let config: Record<string, unknown>;
          try {
            install = JSON.parse(connector.config_json) as ComposioInstallConfig;
            config = JSON.parse(task.trigger_config_json) as Record<string, unknown>;
          } catch {
            res.status(202).json({ ok: true });
            return;
          }
          if (
            event.metadata.connectedAccount.id !== install.connectedAccountId ||
            event.triggerSlug !== triggerRecipe(task.trigger_recipe)?.triggerSlug
          ) {
            res.status(202).json({ ok: true });
            return;
          }
          const recipe = triggerRecipe(task.trigger_recipe);
          const receivedAt = new Date().toISOString();
          const normalized = recipe?.normalize(
            event.payload ?? {},
            config,
            install.connectedAccountId,
            receivedAt,
          );
          if (!normalized) {
            res.status(202).json({ ok: true });
            return;
          }
          const payloadJson = JSON.stringify(normalized);
          if (Buffer.byteLength(payloadJson, 'utf8') > MAX_NORMALIZED_EVENT_BYTES) {
            res.status(413).json({ ok: false, error: 'Normalized event is too large' });
            return;
          }
          const eventId = typeof raw.id === 'string' ? raw.id : String(req.headers['webhook-id'] ?? '');
          if (!eventId) {
            res.status(400).json({ ok: false, error: 'Event id is missing' });
            return;
          }
          ctx.db
            .prepare(
              `INSERT OR IGNORE INTO automation_events
               (id, scheduled_task_id, external_trigger_id, occurred_at, payload_json, status, finished_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              eventId,
              task.id,
              event.id,
              normalized.occurredAt,
              payloadJson,
              task.enabled === 1 ? 'pending' : 'ignored',
              task.enabled === 1 ? null : new Date().toISOString(),
            );
          res.status(202).json({ ok: true });
        })
        .catch(() => res.status(401).json({ ok: false, error: 'Invalid webhook signature or payload' }));
    },
  );
  return router;
}
