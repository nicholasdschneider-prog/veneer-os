import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function proxyHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) output[name] = value;
  }
  delete output.host;
  return output;
}

export function proxyHttpRequest({
  req,
  res,
  port,
  path,
  headers = proxyHeaders(req.headers),
  timeoutMs = 20_000,
  onTimeout,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  port: number;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  timeoutMs?: number;
  onTimeout?: () => void;
}): void {
  let settled = false;
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      path,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      settled = true;
      res.writeHead(upstreamResponse.statusCode ?? 502, proxyHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    },
  );

  upstream.setTimeout(timeoutMs, () => {
    onTimeout?.();
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', (error) => {
    if (settled || res.headersSent) {
      res.destroy(error);
      return;
    }
    settled = true;
    const timedOut = error.message === 'upstream timeout';
    res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(timedOut ? 'This app took too long to respond.' : 'This app is temporarily unavailable.');
  });
  req.pipe(upstream);
}
