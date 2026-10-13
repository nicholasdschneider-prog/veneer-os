import net from 'node:net';

const installed = Symbol.for('veneer.typeOfServiceGuard');
let ignored = 0;
let lastLog = 0;

/** Count of setTypeOfService EINVAL errors converted into ordinary socket failures. */
export function ignoredTypeOfServiceErrors(): number {
  return ignored;
}

/**
 * Node 24's bundled undici calls `socket.setTypeOfService()` on the first
 * write of every HTTP/1 request, inside the socket's `connect` handler. On
 * macOS, setsockopt(IP_TOS) returns EINVAL when the peer has already reset the
 * connection (a reset that lands while this process's event loop is busy).
 * Node throws that error with no catch in undici, so one reset peer terminated
 * the whole service. Type of service is best effort (Node already ignores
 * failures on Windows). Ignore only this EINVAL: the reset socket then fails its
 * write and the one request rejects normally. Every other error still throws.
 */
export function installTypeOfServiceGuard(): void {
  const proto = net.Socket.prototype as net.Socket & { setTypeOfService?: SetTypeOfService; [installed]?: true };
  if (typeof proto.setTypeOfService !== 'function' || proto[installed]) return;
  proto.setTypeOfService = guardSetTypeOfService(proto.setTypeOfService);
  proto[installed] = true;
}

type SetTypeOfService = (this: net.Socket, tos: number) => net.Socket;

/** Wraps one setTypeOfService implementation; exported for tests. */
export function guardSetTypeOfService(original: SetTypeOfService): SetTypeOfService {
  return function guardedSetTypeOfService(this: net.Socket, tos: number) {
    try {
      return original.call(this, tos);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EINVAL' || err.syscall !== 'setTypeOfService') throw error;
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
