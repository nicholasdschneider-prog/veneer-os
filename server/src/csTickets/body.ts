/**
 * Make a mirrored email or SMS body readable in the task pane: plain text,
 * no quoted history, no phone signatures, no inline-image placeholders.
 * The folded quoted history is returned separately so the pane can show it
 * on request. The stored body is never changed.
 */
export interface CleanBody { text: string; earlier: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (all, e: string) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()]!;
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
      return all;
    });
}
const LOOKS_HTML = /<(html|body|div|p|br|table|span)[\s>/]/i;
/** Where quoted history starts: "On <date> <name> wrote:" (possibly wrapped onto two lines), an Outlook header block, or a run of "> " lines. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const next = (lines[i + 1] ?? '').trim();
    if (/^On\s.{4,300}\swrote:$/i.test(line)) return i;
    if (/^On\s.{4,300}$/i.test(line) && /^(.{0,200}\s)?wrote:$/i.test(next) && /\d/.test(line)) return i;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(line)) return i;
    if (/^From:\s.+/i.test(line) && /^(Sent|Date|To):\s/i.test(next)) return i;
    if (line.startsWith('>') && (lines.slice(i, i + 3).filter((l) => l.trim().startsWith('>')).length >= 2 || i === lines.length - 1)) return i;
  }
  return -1;
}
const PHONE_SIGNATURE = /\s*Sent from my (iPhone|iPad|Android|Galaxy|Samsung[^\n]*|Verizon[^\n]*|T-Mobile[^\n]*|mobile device|phone)\.?\s*$/i;
const DELIVERY = /\n*\[SMS delivery: [^\]]*\]\s*$/;

export function cleanBody(raw: string): CleanBody {
  let body = (raw ?? '').replace(/\r\n?/g, '\n');
  const delivery = body.match(DELIVERY)?.[0]?.trim() ?? '';
  if (delivery) body = body.replace(DELIVERY, '');
  if (LOOKS_HTML.test(body)) body = htmlToText(body);
  body = body.replace(/\[image:[^\]\n]{0,300}\]/gi, '').replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  const lines = body.split('\n');
  const cut = quoteStart(lines);
  let text = (cut >= 0 ? lines.slice(0, cut) : lines).join('\n');
  const earlier = cut >= 0 ? lines.slice(cut).join('\n').trim() : '';
  for (let i = 0; i < 3 && PHONE_SIGNATURE.test(text); i++) text = text.replace(PHONE_SIGNATURE, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (delivery) text = text ? `${text}\n\n${delivery}` : delivery;
  return { text: text || (earlier ? '' : (raw ?? '').trim()), earlier: earlier.replace(/\n{3,}/g, '\n\n') };
}
