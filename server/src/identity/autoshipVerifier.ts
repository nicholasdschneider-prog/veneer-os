import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';

/**
 * Service identity for the OrderOps AutoShip verifier (option A). A separate
 * Cloudflare Access application with its own audience issues a JWT for one
 * enrolled service token; the JWT carries `common_name`, never `email`.
 * This resolver accepts exactly that identity and nothing else: no users row,
 * role, email or agent conversation is ever attached, so none of the human or
 * bot authorization paths can be reached with it. Absent configuration means
 * the verifier is disabled and every request fails closed.
 */
export interface AutoshipVerifierIdentity {
  kind: 'autoship_verifier';
  clientId: string;
}

export type AutoshipVerifierResolver = (req: IncomingMessage) => Promise<AutoshipVerifierIdentity | null>;

export type VerifyJwt = (token: string, audience: string) => Promise<JWTPayload>;

function normalizeTeamDomain(value: string): string {
  let t = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(t)) {
    if (!t.includes('.')) t = `${t}.cloudflareaccess.com`;
    t = `https://${t}`;
  }
  return t;
}

export function autoshipVerifierEnabled(config: Pick<Config, 'identity' | 'cfTeamDomain' | 'autoshipVerifierCfAud' | 'autoshipVerifierClientId'>): boolean {
  return Boolean(config.identity === 'cloudflare' && config.cfTeamDomain && config.autoshipVerifierCfAud && config.autoshipVerifierClientId);
}

export function createAutoshipVerifierResolver(
  config: Pick<Config, 'identity' | 'cfTeamDomain' | 'autoshipVerifierCfAud' | 'autoshipVerifierClientId'>,
  opts: { verifyJwt?: VerifyJwt; log?: Pick<Console, 'warn'> } = {},
): AutoshipVerifierResolver {
  const log = opts.log ?? console;
  if (!autoshipVerifierEnabled(config)) return async () => null;
  const audience = config.autoshipVerifierCfAud!;
  const clientId = config.autoshipVerifierClientId!;
  const verify: VerifyJwt = opts.verifyJwt ?? (() => {
    const team = normalizeTeamDomain(config.cfTeamDomain!);
    const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    return async (token, aud) =>
      (await jwtVerify(token, jwks, { issuer: team, audience: aud, algorithms: ['RS256'] })).payload;
  })();
  return async (req) => {
    const token = String(req.headers['cf-access-jwt-assertion'] ?? '').trim();
    if (!token) return null;
    try {
      const payload = await verify(token, audience);
      // Service Auth JWTs carry common_name only. A JWT that also carries an
      // email claim is a human identity on the wrong path: reject.
      if (typeof payload.email === 'string' && payload.email.trim()) return null;
      const commonName = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
      if (!commonName || commonName !== clientId) return null;
      return { kind: 'autoship_verifier', clientId: commonName };
    } catch (err) {
      log.warn(`[autoship-verifier] JWT rejected: ${(err as Error).message}`);
      return null;
    }
  };
}
