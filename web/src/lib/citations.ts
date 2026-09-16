import { marked, type Tokens } from 'marked';

export interface Citation {
  number: number;
  url: string;
  title: string;
  site: string;
}

const RELATIVE_BASE = 'https://veneer.local';
const CITATION_LABEL_RE = /^\[?\s*\d+\s*\]?$/;

interface CitationUrl {
  key: string;
  url: string;
  site: string;
}

function citationUrl(href: string): CitationUrl | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, RELATIVE_BASE);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const relative = parsed.origin === RELATIVE_BASE;
    return {
      key: parsed.toString(),
      url: relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString(),
      site: relative ? 'Veneer Pro' : parsed.hostname.replace(/^www\./, ''),
    };
  } catch {
    return null;
  }
}

export function isCitationLabel(text: string): boolean {
  return CITATION_LABEL_RE.test(text.trim());
}

export function citationKey(href: string): string | null {
  return citationUrl(href)?.key ?? null;
}

export function extractCitations(markdown: string): Citation[] {
  const citations: Citation[] = [];
  const numbers = new Map<string, number>();
  const tokens = marked.lexer(markdown);

  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'link') return;
    const link = token as Tokens.Link;
    if (!isCitationLabel(link.text)) return;
    const source = citationUrl(link.href);
    if (!source || numbers.has(source.key)) return;

    const number = citations.length + 1;
    numbers.set(source.key, number);
    citations.push({
      number,
      url: source.url,
      title: link.title?.trim() || source.site,
      site: source.site,
    });
  });

  return citations;
}

export function citationForHref(href: string, citations: Citation[]): Citation | null {
  const key = citationKey(href);
  if (!key) return null;
  return citations.find((citation) => citationKey(citation.url) === key) ?? null;
}

export function citationPayload(citations: Citation[]): string {
  return JSON.stringify(citations);
}

export function citationsFromPayload(payload: string | undefined): Citation[] {
  if (!payload) return [];
  try {
    const value = JSON.parse(payload) as unknown;
    if (!Array.isArray(value)) return [];
    const citations: Citation[] = [];
    for (const item of value) {
      if (
        typeof item !== 'object'
        || item === null
        || !Number.isInteger((item as Citation).number)
        || (item as Citation).number < 1
        || typeof (item as Citation).url !== 'string'
        || typeof (item as Citation).title !== 'string'
        || typeof (item as Citation).site !== 'string'
        || !citationKey((item as Citation).url)
      ) {
        return [];
      }
      citations.push(item as Citation);
    }
    return citations;
  } catch {
    return [];
  }
}
