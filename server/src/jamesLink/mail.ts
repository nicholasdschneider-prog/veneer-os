import { Composio } from '@composio/core';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';

/**
 * The James link's only mail path: the owner's existing Gmail connector
 * (Composio session), used to send failover alerts and to read CLOSE/ARCHIVE
 * email commands. Which connector is a james_link_state setting
 * ('gmail_connector_id'); the default is the owner's unlabeled Gmail.
 */

export interface MailMessage {
  messageId: string;
  sender: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<{ messageId: string | null }>;
  /** Recent inbox messages matching a Gmail query. */
  search(query: string, max: number): Promise<MailMessage[]>;
}

const configSchema = z.object({ sessionId: z.string().min(1), connectedAccountId: z.string().min(1) });

function connectorRow(ctx: AppContext, preferredId: number | null) {
  const owner = ctx.db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (!owner) throw new Error('No owner account.');
  const rows = ctx.db
    .prepare(
      `SELECT id, label, config_json FROM user_connectors
        WHERE user_id = ? AND connector_slug = 'gmail' AND status = 'connected' AND access_mode IS NOT 'read_only'
        ORDER BY (label IS NULL) DESC, id`,
    )
    .all(owner.id) as { id: number; label: string | null; config_json: string }[];
  const row = (preferredId !== null ? rows.find((r) => r.id === preferredId) : undefined) ?? rows[0];
  if (!row) throw new Error('No connected full-access owner Gmail connector.');
  return { id: row.id, config: configSchema.parse(JSON.parse(row.config_json)) };
}

function htmlToText(value: string): string {
  if (!/<html|<body|<div|<p[\s>]|<br/i.test(value)) return value;
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function createConnectorMailer(ctx: AppContext, preferredId: () => number | null): Mailer {
  const session = async () => {
    const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
    if (!apiKey) throw new Error('Composio is not configured.');
    const { config } = connectorRow(ctx, preferredId());
    return new Composio({ apiKey, allowTracking: false }).sessions.use(config.sessionId);
  };
  return {
    async send(to, subject, body) {
      const result = await (await session()).execute('GMAIL_SEND_EMAIL', {
        recipient_email: to,
        subject,
        body,
        is_html: false,
      });
      if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Gmail send failed.');
      const data = (result.data ?? {}) as Record<string, unknown>;
      const id = typeof data.id === 'string' ? data.id : typeof data.messageId === 'string' ? data.messageId : null;
      return { messageId: id };
    },
    async search(query, max) {
      const result = await (await session()).execute('GMAIL_FETCH_EMAILS', {
        query,
        max_results: max,
        include_payload: false,
        verbose: true,
      });
      if (result.error) throw new Error(typeof result.error === 'string' ? result.error : 'Gmail search failed.');
      const data = (result.data ?? {}) as { messages?: unknown[] };
      return (data.messages ?? []).flatMap((m) => {
        const msg = m as Record<string, unknown>;
        const preview = (msg.preview ?? {}) as Record<string, unknown>;
        const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
        if (!messageId) return [];
        const raw = typeof msg.messageText === 'string' && msg.messageText ? msg.messageText : String(preview.body ?? '');
        return [{
          messageId,
          sender: String(msg.sender ?? ''),
          subject: String(msg.subject ?? preview.subject ?? ''),
          text: htmlToText(raw),
        }];
      });
    },
  };
}
