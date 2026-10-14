import net from 'node:net';

const installed = Symbol.for('veneer.typeOfServiceGuard');
let ignored = 0;
let lastLog = 0;

/**
 * Node 24's bundled undici calls socket.setTypeOfService() on the first write
 * of every HTTP/1 request, inside the socket's connect handler. On macOS,
 * setsockopt(IP_TOS) returns EINVAL when the peer already reset the connection
 * while this process's event loop was busy, and nothing catches the throw, so
 * one reset peer terminated the manager. Type of service is best effort (Node
 * ignores failures on Windows). Ignore only that EINVAL: the reset socket then
 * fails its write and the one request rejects normally. Everything else throws.
 * Same contract as server/src/net/typeOfServiceGuard.ts.
 */
export function guardSetTypeOfService(original) {
  return function guardedSetTypeOfService(tos) {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (error?.code !== 'EINVAL' || error?.syscall !== 'setTypeOfService') throw error;
      ignored += 1;
      const now = Date.now();
      if (now - lastLog >= 60_000) {
        lastLog = now;
        console.warn(`[net] ignored setTypeOfService EINVAL on a reset socket; the request fails instead (total ${ignored})`);
      }
      return this;
    }
  };
}

export function installTypeOfServiceGuard() {
  const proto = net.Socket.prototype;
  if (typeof proto.setTypeOfService !== 'function' || proto[installed]) return;
  proto.setTypeOfService = guardSetTypeOfService(proto.setTypeOfService);
  proto[installed] = true;
}
