import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_CURSOR_EVENT, AGENT_TARGET_EVENT, createAgentCursorTracker, ticketPurpose } from './cursor.mjs';

const json = (value) => Buffer.from(JSON.stringify(value));

test('ticket purpose defaults safely to viewer', () => {
  assert.equal(ticketPurpose('agent'), 'agent');
  assert.equal(ticketPurpose('viewer'), 'viewer');
  assert.equal(ticketPurpose(undefined), 'viewer');
  assert.equal(ticketPurpose('unexpected'), 'viewer');
});

test('agent cursor events are emitted only after their target is known', () => {
  const tracker = createAgentCursorTracker();
  tracker.clientMessage(json({ id: 7, method: 'Target.attachToTarget', params: { targetId: 'page-1' } }));
  assert.equal(tracker.clientMessage(json({
    id: 8,
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-1',
    params: { type: 'mouseMoved', x: 12, y: 34 },
  })), null);

  tracker.chromeMessage(json({ id: 7, result: { sessionId: 'session-1' } }));
  assert.deepEqual(tracker.clientMessage(json({
    id: 9,
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-1',
    params: { type: 'mousePressed', x: 12.5, y: 34.5, button: 'left' },
  })), {
    method: AGENT_CURSOR_EVENT,
    params: { type: 'mousePressed', x: 12.5, y: 34.5, targetId: 'page-1' },
  });
});

test('tracker accepts auto-attach events and ignores unsafe or unrelated traffic', () => {
  const tracker = createAgentCursorTracker();
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'session-2', targetInfo: { targetId: 'page-2' } },
  }));

  assert.equal(tracker.clientMessage(json({
    id: 1,
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-2',
    params: { type: 'mouseWheel', x: 2, y: 3 },
  })), null);
  assert.equal(tracker.clientMessage(json({
    id: 2,
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-2',
    params: { type: 'mouseMoved', x: Number.MAX_VALUE, y: 3 },
  })), null);
  assert.equal(tracker.clientMessage(json({ method: 'Input.dispatchKeyEvent', params: { text: 'private' } })), null);
  assert.equal(tracker.clientMessage(Buffer.from('not-json')), null);
  assert.equal(tracker.clientMessage(json({}), true), null);
});

test('detaching a target stops cursor events for its old session', () => {
  const tracker = createAgentCursorTracker();
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'session-3', targetInfo: { targetId: 'page-3' } },
  }));
  tracker.chromeMessage(json({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-3' } }));
  assert.equal(tracker.clientMessage(json({
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-3',
    params: { type: 'mouseReleased', x: 1, y: 1 },
  })), null);
});

test('a page command on another tab reports the agent moving there, once', () => {
  const tracker = createAgentCursorTracker();
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'session-1', targetInfo: { targetId: 'page-1', type: 'page' } },
  }));
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'session-2', targetInfo: { targetId: 'page-2', type: 'page' } },
  }));

  assert.deepEqual(tracker.clientEvents(json({ id: 1, method: 'Runtime.evaluate', sessionId: 'session-1', params: {} })), [
    { method: AGENT_TARGET_EVENT, params: { targetId: 'page-1' } },
  ]);
  // Same tab again: nothing new to say.
  assert.deepEqual(tracker.clientEvents(json({ id: 2, method: 'Page.captureScreenshot', sessionId: 'session-1' })), []);
  // Bookkeeping on another tab is not the agent switching to it.
  assert.deepEqual(tracker.clientEvents(json({ id: 3, method: 'Network.enable', sessionId: 'session-2' })), []);
  assert.deepEqual(tracker.clientEvents(json({ id: 4, method: 'Page.bringToFront', sessionId: 'session-2' })), [
    { method: AGENT_TARGET_EVENT, params: { targetId: 'page-2' } },
  ]);
});

test('a click on a new tab yields the target change before the cursor', () => {
  const tracker = createAgentCursorTracker();
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'session-1', targetInfo: { targetId: 'page-1', type: 'page' } },
  }));
  assert.deepEqual(tracker.clientEvents(json({
    id: 1,
    method: 'Input.dispatchMouseEvent',
    sessionId: 'session-1',
    params: { type: 'mousePressed', x: 1, y: 2 },
  })), [
    { method: AGENT_TARGET_EVENT, params: { targetId: 'page-1' } },
    { method: AGENT_CURSOR_EVENT, params: { type: 'mousePressed', x: 1, y: 2, targetId: 'page-1' } },
  ]);
});

test('frames and workers never count as the agent tab', () => {
  const tracker = createAgentCursorTracker();
  tracker.chromeMessage(json({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'frame-1', targetInfo: { targetId: 'iframe-1', type: 'iframe' } },
  }));
  assert.deepEqual(tracker.clientEvents(json({ id: 1, method: 'Runtime.evaluate', sessionId: 'frame-1' })), []);
  assert.deepEqual(tracker.clientEvents(json({ id: 2, method: 'Runtime.evaluate' })), []);
});
