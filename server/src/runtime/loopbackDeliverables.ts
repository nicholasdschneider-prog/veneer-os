import type { ConversationEvent } from './events.js';

const CODE_SPAN_OR_FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
const MARKDOWN_OR_BARE_URL =
  /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)(?:\s+["'][^)]*["'])?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<]+)/gi;
const USER_TESTABLE_INTENT = /\b(?:open|test|try|use|view|preview|share|launch|visit|click|browser|link|url)\b/i;
const LOCAL_OUTPUT_REQUEST = [
  /\b(?:give|send|return|provide|show|share)\b.{0,40}\b(?:localhost|loopback|local-only|local only|127\.0\.0\.1)\b/i,
  /\b(?:localhost|loopback|local-only|local only|127\.0\.0\.1)\b.{0,40}\b(?:link|url|address|preview)\b/i,
  /\b(?:open|test|use|visit)\b.{0,40}\b(?:localhost|loopback|local-only|local only|127\.0\.0\.1)\b/i,
  /\b(?:run|start|serve|keep|leave)\b.{0,40}\b(?:locally|on localhost|at localhost|on 127\.0\.0\.1|at 127\.0\.0\.1|local-only|local only)\b/i,
];
const LOCAL_OUTPUT_NEGATION =
  /\b(?:do not|don't|not|never|avoid|without|instead of)\b.{0,40}\b(?:localhost|loopback|local-only|local only|127\.0\.0\.1)\b/i;

const WARNING =
  '> **Preview unavailable:** This address only exists on the agent machine. The agent must publish the result before you can open it.';

export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '::' ||
    hostname === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function explicitlyRequestedLocalOutput(prompt: string): boolean {
  if (LOCAL_OUTPUT_NEGATION.test(prompt)) return false;
  return LOCAL_OUTPUT_REQUEST.some((pattern) => pattern.test(prompt));
}

function guardedUrl(href: string, label?: string): string | null {
  let candidate = href;
  let suffix = '';
  while (candidate && /[.,;:!?\])}]$/.test(candidate)) {
    suffix = candidate.slice(-1) + suffix;
    candidate = candidate.slice(0, -1);
  }
  if (!isLoopbackHttpUrl(candidate)) return null;
  const rendered = label ? `${label} (\`${candidate}\`, agent-only)` : `\`${candidate}\` (agent-only)`;
  return `${rendered}${suffix}`;
}

function guardProseSegment(segment: string): { markdown: string; changed: boolean } {
  let changed = false;
  const markdown = segment.replace(
    MARKDOWN_OR_BARE_URL,
    (full, label: string | undefined, markdownHref: string | undefined, autolink: string | undefined, bare: string | undefined) => {
      const guarded = guardedUrl(markdownHref ?? autolink ?? bare ?? '', label);
      if (!guarded) return full;
      changed = true;
      return guarded;
    },
  );
  return { markdown, changed };
}

export function guardLoopbackDeliverableMarkdown(prompt: string, markdown: string): string {
  if (explicitlyRequestedLocalOutput(prompt)) return markdown;
  if (!USER_TESTABLE_INTENT.test(prompt) && !USER_TESTABLE_INTENT.test(markdown)) return markdown;

  let changed = false;
  const guarded = markdown
    .split(CODE_SPAN_OR_FENCE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      const result = guardProseSegment(segment);
      if (result.changed) changed = true;
      return result.markdown;
    })
    .join('');
  if (!changed) return markdown;
  return `${guarded.trimEnd()}\n\n${WARNING}`;
}

export function guardLoopbackDeliverableEvents(events: ConversationEvent[]): ConversationEvent[] {
  const prompts = new Map<string, string>();
  return events.map((event) => {
    if (event.type === 'turn_started' && event.role === 'user') {
      prompts.set(event.turnId, event.text);
      return event;
    }
    if (event.type !== 'text_final') return event;
    const markdown = guardLoopbackDeliverableMarkdown(prompts.get(event.turnId) ?? '', event.markdown);
    return markdown === event.markdown ? event : { ...event, markdown };
  });
}
