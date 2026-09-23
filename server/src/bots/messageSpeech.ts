import { marked, type Token, type Tokens } from 'marked';

/** Deterministic rendering: no summarizer can omit qualifications or invent facts. */
export function spokenMarkdown(markdown: string): string {
  const render = (tokens: Token[]): string => tokens.map(token => {
    switch (token.type) {
      case 'space': case 'hr': return '\n';
      case 'br': return '\n';
      case 'table': return (token as Tokens.Table).rows.map(row => row.map((cell, i) =>
        `${render(token.header[i]?.tokens ?? [])}: ${render(cell.tokens)}`,
      ).join('. ')).join('\n');
      case 'list': {
        const list = token as Tokens.List;
        return list.items.map((item, index) => `${list.ordered ? `${Number(list.start) + index}. ` : ''}${item.task ? (item.checked ? 'Completed: ' : 'Not completed: ') : ''}${render(item.tokens)}`).join('\n');
      }
      case 'del': return `Deleted: ${render(token.tokens ?? [])}. `;
      case 'image': return token.text ? `Image: ${token.text}` : '';
      case 'link': return render(token.tokens ?? []);
      case 'html': return token.text.replace(/<[^>]*>/g, '');
      default:
        if ('tokens' in token && token.tokens) return render(token.tokens) + (['paragraph', 'heading', 'blockquote'].includes(token.type) ? '\n' : '');
        return 'text' in token ? String(token.text) : token.raw;
    }
  }).join('');
  return render(marked.lexer(markdown)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** Bound each speech request; preserve every character, including unbroken text. */
export function speechParts(text: string, limit = 2800): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = rest.lastIndexOf(' ', limit);
    if (end < limit / 2) end = limit;
    if (end === limit && /[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) parts.push(rest);
  return parts;
}
