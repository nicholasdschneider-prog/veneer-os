import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError } from './service.js';
import { communicationService } from './communication.js';
import { spokenMarkdown, speechParts } from './messageSpeech.js';

type Saved = { id: string; conversation_id: string; parts_json: string };
export function messageAudioRoutes(ctx: AppContext, speak: (text: string) => Promise<Buffer>) {
  const r = express.Router();
  const s = communicationService(ctx.db);
  const generating = new Map<string, Promise<void>>();
  const access = (req: express.Request, chat: string) => {
    if (req.agentConversationId) throw new BotError(403, 'Choose Listen in the chat to prepare audio');
    return s.access({ user: req.user! }, chat);
  };
  const run = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.set('Cache-Control', 'no-store');
      void fn(req, res).catch(error => {
        if (error instanceof BotError) res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError) res.status(400).json({ error: 'Invalid message or audio section' });
        else next(error);
      });
    };
  const saved = (req: express.Request) => {
    const row = ctx.db.prepare('SELECT * FROM message_audio WHERE id=?').get(req.params.id) as Saved | undefined;
    if (!row) throw new BotError(404, 'Message audio unavailable');
    access(req, row.conversation_id);
    const parts = JSON.parse(row.parts_json) as string[];
    const part = z.coerce.number().int().min(0).max(parts.length - 1).parse(req.params.part);
    return { row, parts, part };
  };
  r.post('/chats/:chat/listen', run(async (req, res) => {
    const chat = req.params.chat!;
    access(req, chat);
    const p = z.object({ turn: z.string().min(1).max(200), at: z.string().min(1).max(100) }).strict().parse(req.body);
    const events = await ctx.manager.snapshot(chat);
    access(req, chat);
    const event = events.find(e => e.type === 'text_final' && e.turnId === p.turn && e.at === p.at);
    if (!event || event.type !== 'text_final') throw new BotError(404, 'Original message is unavailable');
    const text = spokenMarkdown(event.markdown);
    if (!text) throw new BotError(400, 'This message has no readable text');
    const hash = crypto.createHash('sha256').update(`v1:${p.turn}:${p.at}:${text}`).digest('hex');
    ctx.db.prepare('INSERT OR IGNORE INTO message_audio(id,conversation_id,source_hash,parts_json) VALUES(?,?,?,?)')
      .run(crypto.randomUUID(), chat, hash, JSON.stringify(speechParts(text)));
    const row = ctx.db.prepare('SELECT * FROM message_audio WHERE conversation_id=? AND source_hash=?').get(chat, hash) as Saved;
    res.json({ id: row.id, parts: (JSON.parse(row.parts_json) as string[]).length });
  }));
  r.post('/message-audio/:id/:part', run(async (req, res) => {
    const { row, parts, part } = saved(req);
    const cached = () => ctx.db.prepare('SELECT audio FROM message_audio_parts WHERE message_id=? AND part=?').get(row.id, part) as { audio: Buffer } | undefined;
    const key = `${row.id}:${part}`;
    if (!cached()) {
      if (!generating.has(key)) {
        // One generation per message; bounded global concurrency avoids runaway long-message requests.
        if (generating.size >= 4 || [...generating.keys()].some(k => k.startsWith(`${row.id}:`)))
          throw new BotError(429, 'Audio is busy. Try again shortly.');
        generating.set(key, (async () => {
          const audio = await speak(parts[part]!);
          access(req, row.conversation_id);
          if (!audio.length || audio.length > 8_000_000) throw new BotError(503, 'Could not prepare this audio section');
          ctx.db.prepare('INSERT OR IGNORE INTO message_audio_parts(message_id,part,audio) VALUES(?,?,?)').run(row.id, part, audio);
        })().finally(() => generating.delete(key)));
      }
      await generating.get(key);
    }
    access(req, row.conversation_id);
    res.json({ url: `/api/bot-communication/message-audio/${row.id}/${part}` });
  }));
  r.get('/message-audio/:id/:part', run(async (req, res) => {
    const { row, part } = saved(req);
    const cached = ctx.db.prepare('SELECT audio FROM message_audio_parts WHERE message_id=? AND part=?').get(row.id, part) as { audio: Buffer } | undefined;
    if (!cached) throw new BotError(404, 'Prepare this audio section first');
    res.type('audio/mpeg').set('Accept-Ranges', 'bytes');
    const range = req.range(cached.audio.length);
    if (range === -1) {
      res.set('Content-Range', `bytes */${cached.audio.length}`).status(416).end();
      return;
    }
    if (range && range !== -2 && range.type === 'bytes' && range.length === 1) {
      const { start, end } = range[0]!;
      res.set('Content-Range', `bytes ${start}-${end}/${cached.audio.length}`).status(206).send(cached.audio.subarray(start, end + 1));
      return;
    }
    res.send(cached.audio);
  }));
  return r;
}
