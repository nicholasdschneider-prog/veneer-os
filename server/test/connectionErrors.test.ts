import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { guardConnectionErrors } from '../src/channels/connectionErrors.js';

it('survives a peer error while an upgraded socket awaits authentication', async () => {
  const server = createServer((_req, res) => res.end('healthy'));
  guardConnectionErrors(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const upgraded = once(server, 'upgrade');
  const client = connect(port, '127.0.0.1');
  client.on('error', () => {});
  try {
    client.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    const [, socket] = await upgraded;
    // Deterministically reproduce the actual ECONNRESET in the authentication gap.
    expect(() => socket.emit('error', Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'}))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('healthy');
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
