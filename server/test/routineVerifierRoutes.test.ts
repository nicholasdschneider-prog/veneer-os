import { it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import type { Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { configuredRoutineIdentity, routineVerifierRoutes } from '../src/bots/routineVerifierRoutes.js';
const config = { cfAud: 'human', autoshipVerifierCfAud: 'autoship', autoshipVerifierClientId: 'autoship-client', returnVerifierCfAud: 'return', returnVerifierClientId: 'return-client', routineVerifierCfAud: 'routine', routineVerifierClientId: 'routine-client' } as Config;
it('requires separate routine audience and service client; no human, AutoShip or return fallback', () => {
  expect(configuredRoutineIdentity(config)).toEqual({ clientId: 'routine-client', audience: 'routine' });
  for (const audience of ['human','autoship','return',null]) expect(configuredRoutineIdentity({ ...config, routineVerifierCfAud: audience })).toBeNull();
  for (const client of ['return-client','autoship-client',null]) expect(configuredRoutineIdentity({ ...config, routineVerifierClientId: client })).toBeNull();
});
it('rejects unauthenticated capture before touching source or business records', async () => {
  const db = new Database(':memory:'), app = express();
  app.use('/api/routine-message/verifier', routineVerifierRoutes({ db, config } as AppContext, async () => null));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/routine-message/verifier/captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eligible: true }) });
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
