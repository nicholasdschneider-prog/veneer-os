import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tunnelPid, metricsAddress, inspectTunnel, inspectPublicEdge } from '../scripts/tunnel-health.mjs';

test('attributes readiness to the log-owning tunnel rather than another default-port tunnel', async () => {
  const calls = [];
  const result = await inspectTunnel('/fixture/veneer.log', {
    exec: async (_file, args) => {
      calls.push(args);
      return {stdout: calls.length === 1 ? 'p752\nccloudflared\nf1\nf2\n' : 'p752\nf9\nn127.0.0.1:20242\n'};
    },
    fetcher: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:20242/ready');
      assert.equal(options.redirect, 'error');
      return Response.json({status: 200, readyConnections: 4});
    },
  });
  assert.match(result, /4 active edge connections/);
  assert.match(result, /unverified/);
  assert.ok(calls[1].includes('752'));
});

test('refuses ambiguous, unrelated, non-loopback, or missing listeners', () => {
  for (const data of ['', 'p2\ncnode\n', 'p1\nccloudflared\np2\nccloudflared\n']) assert.throws(() => tunnelPid(data));
  for (const data of ['p2\nn127.0.0.1:20241\n', 'p1\nn*:20241\n', 'p1\nn192.0.2.1:20241\n', 'p1\nn127.0.0.1:20241\nn127.0.0.1:20242\n']) assert.throws(() => metricsAddress(data, '1'));
  assert.equal(metricsAddress('p1\nn[::1]:20242\n', '1'), 'http://[::1]:20242');
});

for (const [status, body] of [[503, {status:503,readyConnections:0}], [200,{status:200,readyConnections:0}], [200,{status:200,readyConnections:'4'}], [200,{}]]) {
  test(`rejects disconnected or malformed readiness ${status} ${JSON.stringify(body)}`, async () => {
    let calls=0;
    await assert.rejects(inspectTunnel('/fixture/log', {
      exec: async () => ({stdout: ++calls === 1 ? 'p1\nccloudflared\n' : 'p1\nn127.0.0.1:20242\n'}),
      fetcher: async () => Response.json(body,{status}),
    }), /disconnected or readiness invalid/);
  });
}

test('a healthy Access redirect cannot substitute for a disconnected tunnel', async () => {
  const front = await inspectPublicEdge('https://fixture.test/', async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, {status:302,headers:{location:'https://login.fixture.test/'}});
  });
  assert.match(front, /origin\/authenticated chat unverified/);
  await assert.rejects(inspectTunnel('/fixture/log', {exec:async()=>{throw new Error('private subprocess output');}}), error => {
    assert.match(error.message, /readiness unknown/);
    assert.doesNotMatch(error.message, /private subprocess/);
    return true;
  });
});

test('public errors do not echo credentials, URLs, or response bodies', async () => {
  for (const url of ['https://name:secret@fixture.test/', 'http://fixture.test/']) {
    await assert.rejects(inspectPublicEdge(url, async()=>{throw Error('must not fetch');}), /URL invalid/);
  }
  await assert.rejects(inspectPublicEdge('https://fixture.test/?s=private', async()=>new Response('private', {status:502})), error=>!error.message.includes('private'));
});
