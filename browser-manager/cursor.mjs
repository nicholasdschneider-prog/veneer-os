export const AGENT_CURSOR_EVENT = 'Veneer.agentCursor';
// Which page the agent is working in. The agent-browser daemon keeps its
// selected tab to itself, so the tab is inferred from where the agent's
// commands go: any command that reads or drives a page counts, bookkeeping
// (Target.*, Network.*, Emulation.*) does not.
export const AGENT_TARGET_EVENT = 'Veneer.agentTarget';

const CURSOR_TYPES = new Set(['mouseMoved', 'mousePressed', 'mouseReleased']);
const INTENT_DOMAINS = ['Input.', 'DOM.', 'Accessibility.'];
const INTENT_METHODS = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  'Page.bringToFront',
  'Page.handleJavaScriptDialog',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
]);

function isIntent(method) {
  return INTENT_METHODS.has(method) || INTENT_DOMAINS.some((domain) => method.startsWith(domain));
}
const MAX_COORDINATE = 100_000;

export function ticketPurpose(value) {
  // Missing purpose can happen briefly during a rolling update. Viewer is the
  // safe fallback: it can never make human input look like agent input.
  return value === 'agent' ? 'agent' : 'viewer';
}

function messageObject(data, binary) {
  if (binary) return null;
  try {
    const value = JSON.parse(String(data));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeTargetId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/** Tracks one agent CDP connection without retaining page content or input text. */
export function createAgentCursorTracker() {
  const pendingAttach = new Map();
  const sessionTargets = new Map();
  // Sessions the daemon attached to non-page targets (frames, workers) never
  // count as "the tab the agent is on".
  const nonPageSessions = new Set();
  let currentTargetId = null;

  function cursorEvent(message) {
    if (message.method !== 'Input.dispatchMouseEvent') return null;
    const type = String(message.params?.type ?? '');
    const x = Number(message.params?.x);
    const y = Number(message.params?.y);
    const targetId = sessionTargets.get(String(message.sessionId ?? '')) ?? null;
    if (
      !CURSOR_TYPES.has(type) ||
      !targetId ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > MAX_COORDINATE ||
      Math.abs(y) > MAX_COORDINATE
    ) {
      return null;
    }
    return { method: AGENT_CURSOR_EVENT, params: { type, x, y, targetId } };
  }

  function targetEvent(message) {
    const method = String(message.method ?? '');
    const sessionId = String(message.sessionId ?? '');
    if (!sessionId || !isIntent(method) || nonPageSessions.has(sessionId)) return null;
    const targetId = sessionTargets.get(sessionId) ?? null;
    if (!targetId || targetId === currentTargetId) return null;
    currentTargetId = targetId;
    return { method: AGENT_TARGET_EVENT, params: { targetId } };
  }

  return {
    /** Every viewer event one agent message produces, target change first. */
    clientEvents(data, binary = false) {
      const message = messageObject(data, binary);
      if (!message) return [];

      if (message.method === 'Target.attachToTarget' && Number.isInteger(message.id)) {
        const targetId = safeTargetId(message.params?.targetId);
        if (targetId) pendingAttach.set(message.id, targetId);
        return [];
      }
      if (message.method === 'Target.detachFromTarget') {
        const detached = safeTargetId(message.params?.sessionId);
        if (detached) sessionTargets.delete(detached);
        return [];
      }
      return [targetEvent(message), cursorEvent(message)].filter(Boolean);
    },

    /** The cursor event alone; kept for callers that only overlay the pointer. */
    clientMessage(data, binary = false) {
      return this.clientEvents(data, binary).find((event) => event.method === AGENT_CURSOR_EVENT) ?? null;
    },

    chromeMessage(data, binary = false) {
      const message = messageObject(data, binary);
      if (!message) return;

      if (Number.isInteger(message.id) && pendingAttach.has(message.id)) {
        const targetId = pendingAttach.get(message.id);
        pendingAttach.delete(message.id);
        const sessionId = safeTargetId(message.result?.sessionId);
        if (sessionId && targetId) sessionTargets.set(sessionId, targetId);
      }
      if (message.method === 'Target.attachedToTarget') {
        const sessionId = safeTargetId(message.params?.sessionId);
        const targetId = safeTargetId(message.params?.targetInfo?.targetId);
        const type = message.params?.targetInfo?.type;
        if (sessionId && targetId) {
          sessionTargets.set(sessionId, targetId);
          if (typeof type === 'string' && type !== 'page') nonPageSessions.add(sessionId);
        }
      }
      if (message.method === 'Target.detachedFromTarget') {
        const sessionId = safeTargetId(message.params?.sessionId);
        if (sessionId) {
          sessionTargets.delete(sessionId);
          nonPageSessions.delete(sessionId);
        }
      }
    },
  };
}
