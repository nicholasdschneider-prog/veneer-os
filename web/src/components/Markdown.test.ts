import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  escapeDanglingFence,
  handleInlineCopyClick,
  Markdown,
  MarkdownImageSourcesContext,
  normalizeMathDelimiters,
  type MarkdownMode,
} from './Markdown';
import { chatImageSources } from '../lib/chatImageSources';
import { setPagesPublicBase } from '../lib/artifacts';

const ORIGIN = 'http://localhost:5173';
const hadWindow = 'window' in globalThis;

beforeAll(() => {
  (globalThis as { window?: unknown }).window = { location: { origin: ORIGIN } };
});

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

function rendered(markdown: string, mode: MarkdownMode = 'static'): string {
  return renderToStaticMarkup(createElement(Markdown, { markdown, mode }));
}

function renderedAfterSuspense(
  markdown: string,
  mode: MarkdownMode = 'static',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    output.on('error', reject);

    const stream = renderToPipeableStream(createElement(Markdown, { markdown, mode }), {
      onAllReady() {
        stream.pipe(output);
      },
      onShellError: reject,
    });
  });
}

describe('shared Markdown rendering', () => {
  it.each(['static', 'streaming'] as const)('routes the original local image Markdown through detected chat files in %s mode', (mode) => {
    const filePath = '/private/tmp/crew-c100172a-review/01-wrong-layer.png';
    const sources = chatImageSources('origin-chat', [{ path: filePath, name: '01-wrong-layer.png', source: 'bash', size: 123, mtime: 1 }], []);
    const html = renderToStaticMarkup(createElement(MarkdownImageSourcesContext.Provider, { value: sources },
      createElement(Markdown, { markdown: '![Wrong-layer outline](/tmp/crew-c100172a-review/01-wrong-layer.png)', mode }),
    ));
    expect(html).toContain(`src="/api/conversations/origin-chat/files/content?path=${encodeURIComponent(filePath)}&amp;inline=1"`);
    expect(html).toContain('alt="Wrong-layer outline"');
    expect(html).not.toContain('src="/tmp/');
  });

  it('matches encoded and angle-bracket paths with spaces against registered artifacts', () => {
    const sources = chatImageSources('chat', [], [{ type: 'file', id: 'image-id', path: '/Users/sam/My Images/plot.png', name: 'plot.png', kind: 'image', size: 123, updatedAt: 1 }]);
    for (const target of ['/Users/sam/My Images/plot.png', '</Users/sam/My Images/plot.png>', '/Users/sam/My%20Images/plot.png']) {
      const html = renderToStaticMarkup(createElement(MarkdownImageSourcesContext.Provider, { value: sources },
        createElement(Markdown, { markdown: `![Plot](${target})` }),
      ));
      expect(html).toContain('src="/api/generated-files/image-id/download?inline=1"');
    }
  });

  it('leaves remote images alone and never routes unknown local images to host files', () => {
    const html = rendered('![Unknown](/tmp/unlisted.png)\n\n![Remote](https://example.com/tmp/chart.png)');
    expect(html).toContain('Image unavailable: Unknown');
    expect(html).not.toContain('src="/tmp/unlisted.png"');
    expect(html).not.toContain('/api/conversations/');
    expect(html).toContain('src="https://example.com/tmp/chart.png"');
  });

  it('renders GFM structure and preserves soft line breaks', () => {
    const html = rendered('# Report\n\n- **Passed**\n- Complete\n\nfirst\nsecond');

    expect(html).toContain('<h1>Report</h1>');
    expect(html).toContain('<li><strong>Passed</strong></li>');
    expect(html).toContain('first<br/>\nsecond');
  });

  it.each(['static', 'streaming'] as const)(
    'keeps paired approximation tildes literal in %s messages',
    (mode) => {
      const html = rendered('That price is ~**2× breakeven** (~$0.0019 gross redeem value).', mode);

      expect(html).toContain('~<strong>2× breakeven</strong> (~$0.0019 gross redeem value)');
      expect(html).not.toContain('<del>');
    },
  );

  it('still renders intentional double-tilde strikethrough', () => {
    const html = rendered('Keep this, but ~~remove this~~.');

    expect(html).toContain('<del>remove this</del>');
  });

  it('leaves tildes inside inline and fenced code untouched', () => {
    const html = rendered('`~literal~`\n\n```text\n~~literal~~\n```');

    expect(html).toContain('>~literal~<');
    expect(html).toContain('~~literal~~');
    expect(html).not.toContain('<del>');
  });

  it('sanitizes unsafe HTML while preserving native details', () => {
    const html = rendered('<details><summary>More</summary>Safe<script>alert(1)</script></details>');

    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('Safe');
    expect(html).not.toContain('<script');
  });

  it('keeps local file links with spaces clickable', () => {
    const html = rendered('[Report](/Users/sam/My Report.md)');

    expect(html).toContain('href="/Users/sam/My%20Report.md"');
    expect(html).toContain('>Report</a>');
  });

  it('turns an inline-code absolute path into a file link and leaves other code alone', () => {
    const html = rendered('Report: `/Users/you/Developer/Crew%20Seating/out/report.md` then run `npm test`.');

    expect(html).toContain('<a href="/Users/you/Developer/Crew%20Seating/out/report.md" class="vp-file-path" data-file-path="">');
    expect(html).toContain('/Users/you/Developer/Crew Seating/out/report.md</code></a>');
    expect(html).toContain('>npm test<');
    expect(html).not.toContain('href="npm');
  });

  it('routes Mermaid fences through the shared interactive diagram renderer', async () => {
    const html = await renderedAfterSuspense([
      '```mermaid',
      'flowchart LR',
      '  A[Ask Veneer] --> B[See diagram]',
      '```',
    ].join('\n'));

    expect(html).toContain('data-streamdown="mermaid-block"');
    expect(html).toContain('title="Copy Code"');
    expect(html).toContain('title="View fullscreen"');
    expect(html).toContain('<span>Expand</span>');
    expect(html).not.toContain('class="language-mermaid"');
  });

  it('keeps ordinary fenced code readable with only the copy control', () => {
    const html = rendered('```typescript\nconst ready = true;\n```');

    expect(html).toContain('const ready = true;');
    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('title="Copy Code"');
    expect(html).not.toContain('title="Download file"');
    expect(html).not.toContain('data-streamdown="mermaid-block"');
    expect(html).not.toContain('title="View fullscreen"');
  });

  it.each(['text', 'plaintext', 'txt'])('renders compact, copyable %s fences through the shared code renderer', (language) => {
    const html = rendered(`\`\`\`${language}\nA compact plain-text value\n\`\`\``);

    expect(html).toContain(`data-language="${language}"`);
    expect(html).toContain('data-streamdown="code-block"');
    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('A compact plain-text value');
  });

  it('makes an unlabeled fence copyable without adding a useful-language label', () => {
    const html = rendered('```\nA compact unlabeled value\n```');

    expect(html).toContain('data-language=""');
    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('A compact unlabeled value');
  });

  it('uses one fenced-code surface and hides labels only when they add no meaning', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

    expect(css).toContain("[data-streamdown='code-block-body'] pre");
    expect(css).toContain("[data-language='text' i]");
    expect(css).toContain("[data-language='plaintext' i]");
    expect(css).toContain("[data-language='txt' i]");
    expect(css).toContain("[data-streamdown='code-block-header']");
    expect(css).toContain("[data-streamdown='code-block-copy-button']");
    expect(css).toMatch(/\[data-streamdown='code-block'\] \{[\s\S]*?border: 1px solid/);
    expect(css).toContain(") {\n  background: transparent;\n}\n.prose-assistant [data-streamdown='code-block']:is(");
    expect(css).toMatch(/\[data-language='txt' i\][\s\S]*?\[data-streamdown='code-block-header'\] \{\s*display: none;/);
    expect(css).toContain("[data-streamdown='code-block-copy-button']::after");
    expect(css).toContain('background: transparent');
  });

  it('recognizes an incomplete Mermaid fence while a response is streaming', async () => {
    const html = await renderedAfterSuspense(
      '```mermaid\nflowchart LR\n  A[Planning] --> B[Building]',
      'streaming',
    );

    expect(html).toContain('data-streamdown="mermaid-block"');
  });
});

describe('math rendering', () => {
  it('renders the exact display-math form that broke in the DEEP transcript', () => {
    const html = rendered([
      'The vault mints:',
      '',
      '\\[',
      'M = D \\times \\frac{S}{B}',
      '\\]',
      '',
      '\\[',
      'M = 9{,}289{,}856.251234',
      '\\times',
      '\\frac{25{,}826{,}324.704814}{33{,}629{,}630.096046}',
      '\\]',
    ].join('\n'));

    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).toContain('mfrac');
    expect(html).not.toContain('<br/>\n[');
  });

  it('supports common inline delimiters and native double-dollar math', () => {
    const html = rendered('Inline \\(x^2\\) and $$y^2$$.');

    expect(html.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('\\(x^2\\)');
  });

  it('does not mistake currency for math', () => {
    const html = rendered('Current value: $21,629. Average: $0.002328 per DEEP.');

    expect(html).toContain('$21,629');
    expect(html).toContain('$0.002328');
    expect(html).not.toContain('class="katex"');
  });

  it('does not normalize delimiters inside code spans or fenced code blocks', () => {
    const markdown = [
      'Outside \\(x\\).',
      '',
      '`inline \\(x\\)`',
      '',
      '```tex',
      '\\[',
      '\\frac{a}{b}',
      '\\]',
      '```',
    ].join('\n');
    const normalized = normalizeMathDelimiters(markdown);

    expect(normalized).toContain('Outside $$x$$.');
    expect(normalized).toContain('`inline \\(x\\)`');
    expect(normalized).toContain('```tex\n\\[\n\\frac{a}{b}\n\\]\n```');
  });

  it('renders incomplete streaming math and keeps malformed static math readable', () => {
    const streaming = rendered('Working:\n\n\\[\nx = \\frac{1}{2}', 'streaming');
    const malformed = rendered('Before \\[ x');

    expect(streaming).toContain('class="katex-display"');
    expect(streaming).toContain('mfrac');
    expect(malformed).toContain('Before');
    expect(malformed).toContain('x');
  });

  it('renders completed historical math in static mode', () => {
    const html = rendered('Completed: \\(x + 1\\).', 'static');

    expect(html).toContain('class="katex"');
    expect(html).toContain('Completed:');
    expect(html).not.toContain('\\(x + 1\\)');
  });
});

describe('citation Markdown rendering', () => {
  it('renumbers explicit citation links while leaving normal links unchanged', () => {
    const html = rendered([
      'First [8](https://example.com/a "Alpha").',
      'Repeated [4](https://example.com/a).',
      'Second [9](https://example.org/b "Beta").',
      '[Normal link](https://example.net).',
    ].join(' '));

    expect(html.match(/data-citation-number="1"/g)).toHaveLength(2);
    expect(html.match(/data-citation-number="2"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open citation 1: Alpha"');
    expect(html).toContain('>Normal link</a>');
    expect(html).not.toContain('data-citation-number="8"');
  });
});

describe('special link rendering', () => {
  // The trusted page host comes from the server's configured pages base.
  beforeAll(() => setPagesPublicBase('https://pages.example.com'));
  afterAll(() => setPagesPublicBase(null));

  it('marks a published-page /p/ link with the Pages icon and keeps the label', () => {
    const html = rendered('See [Open the system map](https://pages.example.com/p/system-map).');

    expect(html).toContain('class="vp-page-link"');
    expect(html).toContain('data-page-link=""');
    expect(html).toContain('<span>Open the system map</span>');
    expect(html).toContain('href="https://pages.example.com/p/system-map"');
  });

  it('leaves a /p/ link on an unconfigured host undecorated', () => {
    expect(rendered('[Elsewhere](https://other.example/p/old-slug)')).not.toContain('vp-page-link');
  });

  it('leaves ordinary links unchanged', () => {
    const html = rendered('Notes on [GitHub](https://github.com/example/repo).');

    expect(html).not.toContain('vp-page-link');
    expect(html).toContain('href="https://github.com/example/repo"');
    expect(html).toContain('>GitHub</a>');
  });

  it('leaves citation pills distinct from published-page links', () => {
    const html = rendered('See [1](https://pages.example.com/p/cited "Cited page").');

    expect(html).toContain('class="vp-citation-link"');
    expect(html).not.toContain('vp-page-link');
  });

  it('marks Watch-live links as the desktop chip', () => {
    const html = rendered('Open [the desktop](/desktop).');

    expect(html).toContain('class="vp-watch-desktop"');
    expect(html).toContain('data-watch-desktop=""');
    expect(html).toContain('Watch live — agent&#x27;s browser');
  });

  it('does not decorate a font URL on the pages host', () => {
    expect(rendered('[Font](https://pages.example.com/f/f1/Harman-Sans.woff2)')).not.toContain('vp-page-link');
  });
});

describe('dangling code fences', () => {
  const nested = [
    'Create the skill:',
    '',
    '```markdown',
    '# skill',
    '```sh',
    'curl example',
    '```',
    'Rules: keep it short.',
    '```',
    '',
    '3. **Test it** by texting hello.',
  ].join('\n');

  it('escapes the last unclosed fence so the tail renders as prose', () => {
    const escaped = escapeDanglingFence(nested);

    expect(escaped).toBe(nested.replace('Rules: keep it short.\n```', 'Rules: keep it short.\n\\```'));
    const html = rendered(nested, 'static');
    expect(html).toContain('<strong>Test it</strong>');
    expect(html).toContain('<ol');
  });

  it('leaves closed fences, tilde fences, and four-backtick wrappers untouched', () => {
    const closed = 'a\n\n```ts\nx\n```\n\nb';
    const tilde = 'a\n\n~~~\nx\n~~~\n\nb';
    const wrapped = 'a\n\n````markdown\n```sh\ncurl\n```\n````\n\n**b**';

    expect(escapeDanglingFence(closed)).toBe(closed);
    expect(escapeDanglingFence(tilde)).toBe(tilde);
    expect(escapeDanglingFence(wrapped)).toBe(wrapped);
    expect(rendered(wrapped, 'static')).toContain('<strong>b</strong>');
  });

  it('escapes an unclosed tilde fence too', () => {
    expect(escapeDanglingFence('a\n~~~\nb')).toBe('a\n\\~~~\nb');
  });

  it('leaves streaming messages alone while a fence is still open', () => {
    const html = rendered('```ts\nconst x = 1;', 'streaming');

    expect(html).toContain('const');
    expect(html).not.toContain('\\```');
    expect(html).not.toContain('<strong>');
  });
});

// This workspace has no DOM test environment (no jsdom/testing-library), so a
// copy is exercised through the button's own click handler, while the markup
// assertions prove that handler is wired to a real, labelled button.
describe('inline code copy button', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a labelled copy button inside a non-path inline-code span', () => {
    const html = rendered('run `npm run build` first');

    expect(html).toContain('>npm run build<');
    expect(html).toContain('aria-label="Copy"');
    // Frozen static-HTML rows copy through the transcript's delegated [data-copy] handler.
    expect(html).toContain('data-copy="npm run build"');
  });

  it('leaves an absolute-path span as a file link with no copy button', () => {
    const html = rendered('see `/Users/sam/out/report.md`');

    expect(html).toContain('class="vp-file-path"');
    expect(html).not.toContain('aria-label="Copy"');
  });

  it('writes the code text to the clipboard and stops the click propagating', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    await expect(handleInlineCopyClick(click, 'npm run build')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('npm run build');
    expect(click.stopPropagation).toHaveBeenCalled();
    expect(click.preventDefault).toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
    });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    await expect(handleInlineCopyClick(click, 'ls')).resolves.toBe(false);
  });
});
