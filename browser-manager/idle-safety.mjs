import { WebSocket } from 'ws';

// Only a boolean leaves Chrome. Never return input values, text, URLs or tokens.
export const FORM_BUSY_EXPRESSION = `(() => {
  if (document.readyState !== 'complete' || document.querySelector('dialog[open]')) return true;
  const roots = [document];
  while (roots.length) {
    const root = roots.pop();
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      // A query already present in this page URL is recoverable on reopen.
      // Only explicit search controls qualify; drafts and hydrated form values do not.
      const search = el.type === 'search' || !!el.closest('[role=search]');
      if (search && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text','search'].includes(el.type))) && el.value && el.value === el.defaultValue
          && [...new URL(location.href).searchParams.values()].includes(el.value)) continue;
      if (el.isContentEditable && (el.textContent.trim() || document.activeElement === el)) return true;
      if (el instanceof HTMLTextAreaElement && el.value) return true;
      if (el instanceof HTMLSelectElement && [...el.options].some(o => o.selected !== o.defaultSelected)) return true;
      if (el instanceof HTMLInputElement) {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
        if (!['checkbox', 'radio', 'range', 'color'].includes(el.type) && el.value) return true;
        if (['checkbox', 'radio'].includes(el.type)) {
          if (el.checked !== el.defaultChecked) return true;
        } else if (el.value !== el.defaultValue) return true;
      }
    }
  }
  return false;
})()`;

// Read-only safety check, fail closed for dialogs, unresponsive frames, and
// beforeunload handlers. In-memory page state cannot be reconstructed from a
// Chrome profile; never treat a failed inspection as permission to close it.
export async function inspectIdlePages(socketUrl, { timeoutMs = 5000, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(socketUrl, { perMessageDeflate: false });
  let next = 0;
  const pending = new Map();
  const defaultContexts = new Map();
  const deadline = setTimeout(() => socket.terminate(), timeoutMs);
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.on('message', data => {
    try {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context;
        if (context?.auxData?.isDefault) defaultContexts.set(`${message.sessionId}:${context.auxData.frameId}`, context.id);
      }
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error('inspection refused'));
      else call.resolve(message.result);
    } catch { /* No page data is logged. */ }
  });
  const fail = () => { for (const call of pending.values()) call.reject(new Error('inspection disconnected')); pending.clear(); };
  socket.on('error', fail);
  socket.on('close', fail);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('inspection disconnected')));
    });
    const { targetInfos } = await send('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page' || t.type === 'iframe');
    if (!pages.length || pages.length > 50) return { safe: false, reason: 'page_check_unavailable' };
    for (const target of pages) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
      const frames = [frameTree];
      while (frames.length) {
        const tree = frames.pop();
        frames.push(...(tree.childFrames ?? []));
        const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: tree.frame.id, worldName: 'veneer-idle-safety' }, sessionId);
        const evaluated = await send('Runtime.evaluate', { expression: FORM_BUSY_EXPRESSION, contextId: executionContextId, returnByValue: true }, sessionId);
        if (evaluated.exceptionDetails || evaluated.result?.value !== false) return { safe: false, reason: 'unfinished_page' };
        const mainContext = defaultContexts.get(`${sessionId}:${tree.frame.id}`);
        if (!mainContext) return { safe: false, reason: 'page_check_unavailable' };
        const win = await send('Runtime.evaluate', { expression: 'window', contextId: mainContext }, sessionId);
        const { listeners } = await send('DOMDebugger.getEventListeners', { objectId: win.result.objectId }, sessionId);
        if (listeners.some(l => l.type === 'beforeunload')) return { safe: false, reason: 'unfinished_page' };
      }
      await send('Target.detachFromTarget', { sessionId });
    }
    return { safe: true };
  } catch { return { safe: false, reason: 'page_check_unavailable' }; }
  finally { clearTimeout(deadline); socket.terminate(); }
}
