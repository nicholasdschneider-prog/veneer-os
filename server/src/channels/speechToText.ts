import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import { attachSonioxSpeechToText } from './sonioxSpeechToText.js';
import { readVoiceSettings } from './voiceSettings.js';

/** Soniox-only realtime dictation proxy. Provider API keys never reach the browser. */

export function attachSpeechToText(server: Server, ctx: AppContext): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/stt') return; // let attachWebSocket (or others) handle it
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      if (!user || user.status !== 'active') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (client) => {
    const { vocabularyTerms } = readVoiceSettings(ctx.db);
    // Effective key = the Settings override if set, else the env/Doppler default.
    // Read per-connection so a key change in Settings takes effect on the next
    // dictation without restarting the web service.
    const apiKey = effectiveApiKey('soniox', ctx.secrets, ctx.config, ctx.doppler).value;
    if (!apiKey) {
      sendJson(client, {
        message_type: 'error',
        error: 'Soniox is not configured for dictation. Add a key in Settings → Voice.',
      });
      client.close();
      return;
    }
    attachSonioxSpeechToText(client, apiKey, { vocabularyTerms });
  });
}

function sendJson(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket died mid-send */
  }
}
