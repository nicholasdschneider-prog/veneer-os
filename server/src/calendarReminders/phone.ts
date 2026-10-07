import type { ReminderPhone } from './service.js';
import { NICK_PHONE } from './service.js';
import { E164 } from '../voice/phone.js';

/** Static telephone speech with no live-voice session, LLM, action tools or decision retry.
 * Unbound staged adapter. Shared call serialization must be accepted before instantiation.
 * Never retry a failed POST, including timeouts and missing provider IDs.
 */
export function reminderPhoneAdapter(get: (name: string) => string | null, sharedBusy: () => Promise<boolean>, fetcher: typeof fetch = fetch): ReminderPhone {
  return {
    busy: sharedBusy,
    async ended(providerId) {
      if (!/^CA[a-zA-Z0-9]+$/.test(providerId)) throw new Error('Provider scope mismatch.');
      const account = get('TWILIO_VOICE_ACCOUNT_SID'); const key = get('TWILIO_VOICE_API_KEY_SID'); const secret = get('TWILIO_VOICE_API_KEY_SECRET');
      if (!account || !/^AC[a-zA-Z0-9]+$/.test(account) || !key || !secret) throw new Error('Reminder readback not configured.');
      const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${account}/Calls/${providerId}.json`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } });
      if (!response.ok) return false;
      const body = await response.json() as { sid?: unknown; to?: unknown; status?: unknown };
      return body.sid === providerId && body.to === NICK_PHONE && ['completed','busy','no-answer','failed','canceled'].includes(String(body.status));
    },
    async place(input) {
      if (input.to !== NICK_PHONE || !input.twiml.startsWith('<Response><Say language="en-US">Nick, this is your meeting reminder.') || !input.twiml.endsWith('</Say><Hangup/></Response>')) throw new Error('Reminder payload mismatch.');
      const account = get('TWILIO_VOICE_ACCOUNT_SID'); const key = get('TWILIO_VOICE_API_KEY_SID');
      const secret = get('TWILIO_VOICE_API_KEY_SECRET'); const from = get('TWILIO_VOICE_FROM_NUMBER');
      if (!account || !/^AC[a-zA-Z0-9]+$/.test(account) || !key || !secret || !from || !E164.test(from)) throw new Error('Reminder phone not configured.');
      const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${account}/Calls.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: NICK_PHONE, From: from, Twiml: input.twiml, Timeout: '25', TimeLimit: '60' }) });
      if (!response.ok) throw new Error('Reminder provider outcome uncertain.');
      const body = await response.json() as { sid?: unknown };
      if (typeof body.sid !== 'string' || !/^CA[a-zA-Z0-9]+$/.test(body.sid)) throw new Error('Reminder provider receipt unavailable.');
      return { providerId: body.sid };
    },
  };
}
