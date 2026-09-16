/** Compact, bounded text rendering of a transcript for another agent to read. */
export function summarizeConversation(conv: Record<string, unknown>, events: unknown[]): string {
  const lines = [`Chat: "${conv.title ?? '(untitled)'}" — agent: ${conv.assistantSlug} — status: ${conv.status}`];
  const pendingApprovals = new Map<string, string>();

  for (const [index, raw] of events.slice(-40).entries()) {
    const event = raw as Record<string, unknown>;
    if (event.type === 'turn_started') lines.push(`User: ${event.text}`);
    else if (event.type === 'text_final') lines.push(`Agent: ${event.markdown}`);
    else if (event.type === 'tool_started') lines.push(`[used tool: ${event.displayName}]`);
    else if (event.type === 'approval_requested') {
      const requestId = String(event.requestId ?? `missing-${index}`);
      pendingApprovals.set(requestId, String(event.toolName ?? 'action'));
    } else if (event.type === 'approval_resolved') {
      pendingApprovals.delete(String(event.requestId ?? ''));
    } else if (event.type === 'notice') lines.push(`[${event.message}]`);
    else if (event.type === 'error') lines.push(`[error: ${event.message}]`);
  }

  for (const toolName of pendingApprovals.values()) lines.push(`[waiting on approval: ${toolName}]`);

  const text = lines.join('\n');
  return text.length > 6000 ? `…(truncated)…\n${text.slice(-6000)}` : text;
}
