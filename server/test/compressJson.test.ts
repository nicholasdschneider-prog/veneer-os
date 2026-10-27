import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressJson } from '../src/net/compressJson.js';

const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, text: 'decision text that repeats' })) };
let server: Server;
let port: number;

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use('/api', compressJson());
  app.get('/api/big', (_req, res) => { res.set('Cache-Control', 'private, no-cache').json(big); });
  app.get('/api/small', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/missing', (_req, res) => { res.status(404).json({ error: 'x'.repeat(4000) }); });
  app.post('/api/big', (_req, res) => { res.json(big); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('compressJson', () => {
  it('gzips large JSON for clients that accept it', async () => {
    const res = await get('/api/big', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers.vary).toMatch(/Accept-Encoding/);
    expect(res.body.length).toBeLessThan(JSON.stringify(big).length / 5);
    expect(JSON.parse(gunzipSync(res.body).toString())).toEqual(big);
  });

  it('sends plain JSON when gzip is not accepted', async () => {
    const res = await get('/api/big', { 'Accept-Encoding': 'identity' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(res.body.toString())).toEqual(big);
  });

  it('leaves small bodies alone', async () => {
    const res = await get('/api/small', { 'Accept-Encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(res.body.toString())).toEqual({ ok: true });
  });

  it('answers an unchanged GET with a bodiless 304', async () => {
    const first = await get('/api/big', { 'Accept-Encoding': 'gzip' });
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^W\//);
    const again = await get('/api/big', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    const stale = await get('/api/big', { 'Accept-Encoding': 'gzip', 'If-None-Match': 'W/"other"' });
    expect(stale.status).toBe(200);
  });

  it('never turns errors or writes into 304s', async () => {
    const missing = await get('/api/missing', { 'Accept-Encoding': 'gzip' });
    expect(missing.status).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
    expect(JSON.parse(gunzipSync(missing.body).toString()).error).toHaveLength(4000);
    const post = await get('/api/big', { 'Accept-Encoding': 'gzip', 'If-None-Match': '*' }, 'POST');
    expect(post.status).toBe(200);
  });
});
