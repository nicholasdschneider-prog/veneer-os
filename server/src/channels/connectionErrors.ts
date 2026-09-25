import type { Server } from 'node:http';

/** Cover the gap between HTTP upgrade and asynchronous identity resolution.
 * Node removes its HTTP socket error handler on upgrade; ws only installs its
 * own after handleUpgrade. A peer reset in between must close one connection,
 * not terminate the web service. Never log socket/request contents here.
 */
export function guardConnectionErrors(server: Server): void {
  server.on('connection', socket => {
    socket.on('error', () => socket.destroy());
  });
}
