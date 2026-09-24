import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';

/**
 * Identity resolution (spec §10, ported from Outpost's
 * cloudflareAccessIdentity.js). Two modes:
 *  - cloudflare: verify Cf-Access-Jwt-Assertion (RS256 vs team JWKS,
 *    aud + iss + exp) and take the email claim; reject otherwise.
 *  - dev: fixed identity (single-owner prototype).
 * Applied to all /api routes AND the WS upgrade.
 */

export interface Identity {
  email: string;
  /** Set when the caller authenticated with a per-turn agent token: the chat
      whose agent is making this request (see runtime/agentTokens.ts). */
  agentConversationId?: string;
    agentExecutionConversationId?: string;
}

export type IdentityResolver = (req: IncomingMessage) => Promise<Identity | null>;

function normalizeTeamDomain(value: string): string {
  let t = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(t)) {
    if (!t.includes('.')) t = `${t}.cloudflareaccess.com`;
    t = `https://${t}`;
  }
  return t;
}

export function createIdentityResolver(config: Config, log: Pick<Console, 'warn'> = console): IdentityResolver {
  if (config.identity === 'dev') {
    return async () => ({ email: config.devEmail });
  }

  const team = normalizeTeamDomain(config.cfTeamDomain!);
  const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  const aud = config.cfAud!;

  return async (req) => {
    const token = String(req.headers['cf-access-jwt-assertion'] ?? '').trim();
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: team,
        audience: aud,
        algorithms: ['RS256'],
      });
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!email) return null;
      return { email };
    } catch (err) {
      log.warn(`[cf-access] JWT rejected: ${(err as Error).message}`);
      return null;
    }
  };
}
