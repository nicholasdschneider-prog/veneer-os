import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

/** Smaller bodies go out as they are; gzip's overhead buys nothing there. */
export const COMPRESS_JSON_MIN_BYTES = 1024;

/**
 * Gzip JSON responses and answer unchanged GETs with 304.
 *
 * The Bots list is several megabytes and every open tab polls it, over the same
 * uplink the office uses. Uncompressed, the sends outlasted the page's read
 * timeout and nothing ever finished. Only res.json is affected; streams, files,
 * SSE and anything that already set Content-Encoding pass through untouched.
 */
export function compressJson(minBytes = COMPRESS_JSON_MIN_BYTES) {
  return (req: Request, res: Response, next: NextFunction) => {
    const plain = res.json.bind(res);
    res.json = (value: unknown) => {
      const body = JSON.stringify(value);
      const size = body === undefined ? 0 : Buffer.byteLength(body);
      if (size < minBytes || res.getHeader('Content-Encoding') || req.method === 'HEAD') return plain(value);
      res.vary('Accept-Encoding');
      if (!res.getHeader('Content-Type')) res.type('json');
      if (req.method === 'GET' && res.statusCode === 200) {
        res.setHeader('ETag', `W/"${size.toString(16)}-${createHash('sha1').update(body).digest('base64url')}"`);
        if (req.fresh) {
          res.status(304).end();
          return res;
        }
      }
      if (!req.acceptsEncodings('gzip')) {
        res.setHeader('Content-Length', size);
        res.end(body);
        return res;
      }
      gzip(body, (err, zipped) => {
        if (res.headersSent || res.destroyed) return;
        if (err) {
          res.setHeader('Content-Length', size);
          res.end(body);
          return;
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', zipped.length);
        res.end(zipped);
      });
      return res;
    };
    next();
  };
}
