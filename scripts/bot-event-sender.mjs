/** OrderOps adapter contract: invoke from the source application's durable event outbox.
 * Supply credentials directly from its secret manager, never from a chat or log.
 * This module does not poll or create customer events. A non-2xx response must
 * leave the source outbox row pending; retry with the same event.id.
 */
import { createHmac } from 'node:crypto';
export async function sendBotEvent({ url, secret, event, fetchImpl = fetch }) {
  const destination = new URL(url);
  if (destination.protocol !== 'https:' || destination.username || destination.password ||
      !/^\/webhooks\/bot-events\/[A-Za-z0-9_-]+$/.test(destination.pathname) || destination.search || destination.hash) {
    throw new Error('Expected an HTTPS Veneer bot-event endpoint');
  }
  if (!secret || typeof secret !== 'string') throw new Error('Event signing credential unavailable');
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
  const response = await fetchImpl(destination, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Veneer-Timestamp': timestamp, 'X-Veneer-Signature': signature }, body,
  });
  if (!response.ok) throw new Error(`Veneer event delivery returned HTTP ${response.status}`);
  const receipt = await response.json();
  if (receipt.ok !== true || !Number.isInteger(receipt.queued)) throw new Error('Invalid Veneer event receipt');
  return { queued: receipt.queued };
}
