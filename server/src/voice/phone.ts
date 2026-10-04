import crypto from 'node:crypto';
import { SipClient } from 'livekit-server-sdk';
import type { AppContext } from '../context.js';

/**
 * Phone leg for bot calls. Twilio dials the person's phone and, once they pick up, bridges the
 * call over SIP into the LiveKit room the voice worker is already serving. Nothing here needs a
 * public webhook: the call's instructions are sent inline and its progress is read back by polling.
 */

export const PHONE_SECRET_NAMES = ['TWILIO_VOICE_ACCOUNT_SID', 'TWILIO_VOICE_API_KEY_SID', 'TWILIO_VOICE_API_KEY_SECRET', 'TWILIO_VOICE_FROM_NUMBER'] as const;
const SIP_SECRET = 'bot-call-sip';
const SIP_TRUNK_NAME = 'veneer-bot-calls';
/** Rooms for phone calls are this prefix plus the digits Twilio dials, so each call lands in its own room. */
export const PHONE_ROOM_PREFIX = 'veneer-voice-phone-';
/** How long the phone rings before the call counts as missed. */
export const PHONE_RING_SECONDS = 25;
/** Hard cap on one phone call. */
export const PHONE_MAX_SECONDS = 5 * 60;
export const E164 = /^\+[1-9]\d{7,14}$/;

type Doppler = Pick<AppContext['doppler'], 'get'>;
type Secrets = Pick<AppContext['secrets'], 'getApiKeyOverride' | 'setApiKeyOverride'>;
export interface PhoneCallStatus { status: string; answeredBy: string | null }
export interface PhoneProvider {
  place(to: string, sipUri: string, sipUser: string, sipPassword: string): Promise<string>;
  status(sid: string): Promise<PhoneCallStatus>;
  hangUp(sid: string): Promise<void>;
}

const xml = (value: string) => value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
/** What Twilio does when the person answers: bridge to the room, and hang up when the room side ends. */
export function bridgeTwiml(sipUri: string, sipUser: string, sipPassword: string, callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xml(callerId)}" timeout="15" timeLimit="${PHONE_MAX_SECONDS}"><Sip username="${xml(sipUser)}" password="${xml(sipPassword)}">${xml(sipUri)}</Sip></Dial></Response>`;
}

export function phoneConfigured(doppler: Doppler): boolean {
  return PHONE_SECRET_NAMES.every((name) => !!doppler.get(name)) && E164.test(doppler.get('TWILIO_VOICE_FROM_NUMBER') ?? '');
}

/** Twilio's REST API with the restricted calls-only key. Credentials are read at use time. */
export function twilioProvider(doppler: Doppler, fetcher: typeof fetch = fetch): PhoneProvider {
  const request = async (path: string, form?: Record<string, string>) => {
    const account = doppler.get('TWILIO_VOICE_ACCOUNT_SID'); const key = doppler.get('TWILIO_VOICE_API_KEY_SID'); const secret = doppler.get('TWILIO_VOICE_API_KEY_SECRET');
    if (!account || !key || !secret) throw new Error('Phone calling is not set up.');
    const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${account}/${path}`, {
      method: form ? 'POST' : 'GET', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // Provider error codes are safe to keep; bodies and credentials are not.
    if (!response.ok) throw new Error(`Phone provider refused the request (${response.status}${typeof body.code === 'number' ? `, code ${body.code}` : ''}).`);
    return body;
  };
  return {
    async place(to, sipUri, sipUser, sipPassword) {
      const from = doppler.get('TWILIO_VOICE_FROM_NUMBER')!;
      const body = await request('Calls.json', { To: to, From: from, Twiml: bridgeTwiml(sipUri, sipUser, sipPassword, from), Timeout: String(PHONE_RING_SECONDS), TimeLimit: String(PHONE_MAX_SECONDS),
        // Detection runs alongside the call, so a person who answers is not kept waiting.
        MachineDetection: 'DetectMessageEnd', AsyncAmd: 'true' });
      if (typeof body.sid !== 'string') throw new Error('Phone provider returned no call id.');
      return body.sid;
    },
    async status(sid) {
      const body = await request(`Calls/${encodeURIComponent(sid)}.json`);
      return { status: String(body.status ?? 'unknown'), answeredBy: typeof body.answered_by === 'string' ? body.answered_by : null };
    },
    async hangUp(sid) { await request(`Calls/${encodeURIComponent(sid)}.json`, { Status: 'completed' }).catch(() => {}); },
  };
}

/** `wss://name-abc123.livekit.cloud` signs SIP in at `abc123.sip.livekit.cloud`. */
export function sipHost(livekitUrl: string): string {
  const sub = new URL(livekitUrl).hostname.split('.')[0]!;
  return `${sub.slice(sub.lastIndexOf('-') + 1)}.sip.livekit.cloud`;
}

interface SipSetup { trunkId: string; ruleId: string; user: string; password: string }
/**
 * One password-protected inbound trunk and one dispatch rule that names the room after the
 * dialed digits. Created once and remembered; the password never leaves the secret store
 * except inside the call instructions sent to the phone provider.
 */
export async function ensureSip(ctx: { secrets: Secrets; doppler: Doppler }, client?: Pick<SipClient, 'createSipInboundTrunk' | 'createSipDispatchRule' | 'listSipInboundTrunk'>): Promise<SipSetup & { host: string }> {
  const url = ctx.doppler.get('LIVEKIT_URL'); const key = ctx.doppler.get('LIVEKIT_API_KEY'); const secret = ctx.doppler.get('LIVEKIT_API_SECRET');
  if (!url || !key || !secret) throw new Error('Live voice is not set up.');
  const host = sipHost(url);
  const sip = client ?? new SipClient(url.replace(/^wss:/, 'https:'), key, secret);
  const saved = ctx.secrets.getApiKeyOverride(SIP_SECRET);
  if (saved) {
    try {
      const setup = JSON.parse(saved) as SipSetup;
      if ((await sip.listSipInboundTrunk()).some((trunk) => trunk.sipTrunkId === setup.trunkId)) return { ...setup, host };
    } catch { /* unreadable or unreachable: fall through and set up again */ }
  }
  const user = 'veneer';
  const password = crypto.randomBytes(24).toString('base64url');
  const trunk = await sip.createSipInboundTrunk(SIP_TRUNK_NAME, [], { authUsername: user, authPassword: password });
  const rule = await sip.createSipDispatchRule({ type: 'callee', roomPrefix: PHONE_ROOM_PREFIX, randomize: false }, { name: SIP_TRUNK_NAME, trunkIds: [trunk.sipTrunkId] });
  const setup: SipSetup = { trunkId: trunk.sipTrunkId, ruleId: rule.sipDispatchRuleId, user, password };
  ctx.secrets.setApiKeyOverride(SIP_SECRET, JSON.stringify(setup));
  return { ...setup, host };
}

/** Digits only: the phone provider and the SIP bridge both pass them through unchanged. */
export const phoneRoomToken = () => String(crypto.randomInt(10 ** 11, 10 ** 12 - 1)) + String(crypto.randomInt(10 ** 5, 10 ** 6 - 1));
/** Final provider states: the call is over and the phone is no longer ringing or connected. */
export const PHONE_ENDED = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
