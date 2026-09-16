/** Same route as the chat menu's Copy Link. Only trusted instance config supplies the base. */
export function conversationShareUrl(publicOrigin: string | null | undefined, conversationId: string, projectId?: string | null): string {
  let base: URL;
  try { base = new URL(publicOrigin ?? ''); }
  catch { throw new Error('Configure this instance public URL (VP_APPS_PUBLIC_ORIGIN) before generating chat links.'); }
  const host = base.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || ['localhost', '::1', '::', '0.0.0.0'].includes(host) || host.endsWith('.localhost')
    || /^127\./.test(host) || /^::ffff:(?:127\.|7f)/.test(host)) {
    throw new Error('Configure a public HTTP(S) instance URL without credentials, query parameters, or a fragment. Loopback links cannot be shared.');
  }
  const route = `#/chat/${encodeURIComponent(conversationId)}`;
  return `${base.origin}${base.pathname}${route}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;
}
