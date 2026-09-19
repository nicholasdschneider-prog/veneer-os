import { effortLabel } from '@/components/chat/ThinkingLevelControl';
import { modelLabel, providerLabel, stripProviderPrefix } from './modelLabel';

/** Same footer the chat composer appends, so bots read attachments the same way. */
export function withAttachmentFooter(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) return body;
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `${body ? `${body}\n\n` : ''}Attached files (saved on this server — read them from these paths):\n${list}`;
}

/** "Claude Opus 5 · High" style chip text for the bot's conversation. */
export function botModelChipLabel(
  provider: string | null,
  model: string | null,
  effort: string | null,
  catalogLabel?: string | null,
): string | null {
  if (!provider) return null;
  let label = providerLabel(provider);
  if (model) label += ` ${stripProviderPrefix(catalogLabel ?? modelLabel(model) ?? model, provider)}`;
  if (effort) label += ` · ${effortLabel(effort)}`;
  return label;
}

export function joinDictation(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition;
  return base.endsWith(' ') || base.endsWith('\n') ? base + addition : `${base} ${addition}`;
}
