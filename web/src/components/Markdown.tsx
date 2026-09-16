import { math } from '@streamdown/math';
import { AppWindow, Check, Copy, Maximize2, Monitor } from 'lucide-react';
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SVGProps,
} from 'react';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  defaultRemarkPlugins,
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type ControlsConfig,
  type DiagramPlugin,
  type ExtraProps,
  type PluginConfig,
} from 'streamdown';
import 'katex/dist/katex.min.css';
import { artifactPathKey, isDesktopWatchLink, isPublishedPageLink, localPathForHref } from '../lib/artifacts';
import { codePathLink, encodeLocalFileLinkTargets } from '../lib/localFileLinks';
import { cn } from '../lib/utils';
import {
  citationForHref,
  extractCitations,
  isCitationLabel,
  type Citation,
} from '../lib/citations';
import {
  isMermaidChartTarget,
  isMermaidTap,
  openMermaidFullscreen,
  type MermaidPointerStart,
} from '../lib/mermaidPresentation';

export type MarkdownMode = 'static' | 'streaming';

// Chats supply URLs for detected files; documents use their scoped image route.
export const MarkdownImageSourcesContext = createContext<ReadonlyMap<string, string>>(new Map());
export const MarkdownDocumentImageContext = createContext<string | null>(null);

function routeDocumentImages({ imageBaseUrl }: { imageBaseUrl: string }) {
  return (tree: { tagName?: string; properties?: { src?: unknown }; children?: unknown[] }) => {
    const visit = (node: typeof tree) => {
      const src = node.properties?.src;
      if (node.tagName === 'img' && typeof src === 'string' && !/^(?:https?:)?\/\//i.test(src)) {
        node.properties!.src = `${imageBaseUrl}${encodeURIComponent(src)}`;
      }
      node.children?.forEach((child) => visit(child as typeof tree));
    };
    visit(tree);
  };
}

function MarkdownImage({ src, alt = '', node: _node, ...props }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const sources = useContext(MarkdownImageSourcesContext);
  const localPath = typeof src === 'string' ? localPathForHref(src) : null;
  const resolved = localPath ? sources.get(artifactPathKey(localPath)) : src;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!resolved || failedSource === resolved) {
    return <span className="text-muted-foreground">Image unavailable{alt ? `: ${alt}` : ''}</span>;
  }
  return <img {...props} src={resolved} alt={alt} onError={() => setFailedSource(resolved)} />;
}

let mermaidPluginPromise: Promise<DiagramPlugin> | undefined;

function loadMermaidPlugin(): Promise<DiagramPlugin> {
  mermaidPluginPromise ??= import('@streamdown/mermaid')
    .then(({ createMermaidPlugin }) => createMermaidPlugin());
  return mermaidPluginPromise;
}

const themedMermaidPlugin: DiagramPlugin = {
  language: 'mermaid',
  name: 'mermaid',
  type: 'diagram',
  getMermaid(config) {
    let activeConfig = config;
    return {
      initialize(nextConfig) {
        activeConfig = { ...activeConfig, ...nextConfig };
      },
      async render(id, source) {
        const dark = typeof document !== 'undefined'
          && getComputedStyle(document.documentElement).colorScheme === 'dark';
        const plugin = await loadMermaidPlugin();
        return plugin.getMermaid({
          fontFamily: 'InterVariable, Inter, ui-sans-serif, system-ui, sans-serif',
          theme: dark ? 'dark' : 'base',
          ...activeConfig,
        }).render(id, source);
      },
    };
  },
};

const STREAMDOWN_PLUGINS: PluginConfig = { math, mermaid: themedMermaidPlugin };
const STREAMDOWN_CONTROLS: ControlsConfig = {
  code: {
    copy: true,
    download: false,
  },
  image: false,
  table: false,
  mermaid: {
    copy: true,
    download: true,
    fullscreen: true,
    panZoom: true,
  },
};
const STREAMDOWN_ICONS = {
  CheckIcon: function CodeCopiedIcon({ size: _size, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
    return <Check {...props} className="size-4 shrink-0" />;
  },
  CopyIcon: function CodeCopyIcon({ size: _size, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
    return <Copy {...props} className="size-4 shrink-0" />;
  },
  Maximize2Icon: function MermaidExpandIcon({ size: _size, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
    return (
      <>
        <Maximize2 {...props} className="size-4 shrink-0" />
        <span>Expand</span>
      </>
    );
  },
};
const STREAMDOWN_LINK_SAFETY = { enabled: false } as const;
const STRICT_GFM_PLUGIN: typeof defaultRemarkPlugins.gfm = [remarkGfm, { singleTilde: false }];
const STREAMDOWN_REMARK_PLUGINS = [
  STRICT_GFM_PLUGIN,
  ...Object.entries(defaultRemarkPlugins)
    .filter(([name]) => name !== 'gfm')
    .map(([, plugin]) => plugin),
  remarkBreaks,
];

// Streamdown ships styled interactive elements by default. Veneer supplies its
// own prose styling and link behavior, so keep native markup except for code:
// Streamdown needs its code renderer to recognize fenced Mermaid diagrams.
const NATIVE_COMPONENTS: Components = {
  a: 'a',
  blockquote: 'blockquote',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
  img: MarkdownImage,
  li: 'li',
  ol: 'ol',
  p: 'p',
  section: 'section',
  strong: 'strong',
  sub: 'sub',
  sup: 'sup',
  table: 'table',
  tbody: 'tbody',
  td: 'td',
  th: 'th',
  thead: 'thead',
  tr: 'tr',
  ul: 'ul',
};

type MarkdownAnchorProps = ComponentPropsWithoutRef<'a'> & ExtraProps;
type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps;

function renderedText(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (!isValidElement(child)) return '';
    return renderedText((child.props as { children?: ReactNode }).children);
  }).join('');
}

/** How long the inline-code copy button shows its confirmation check. */
export const INLINE_COPY_RESET_MS = 1500;

/** Minimal shape of the click the inline copy button handles. */
export interface InlineCopyClick {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Copy the span without letting the click reach the transcript's delegated
 * handlers (which would open a file preview or select the message).
 */
export async function handleInlineCopyClick(event: InlineCopyClick, text: string): Promise<boolean> {
  event.preventDefault();
  event.stopPropagation();
  return copyInlineCode(text);
}

/** Copy one inline-code span; false when the clipboard is missing or refuses. */
export async function copyInlineCode(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flip the button into its "copied" look for a moment. Driven through the DOM
 * rather than React state so it works identically in live rows and in frozen
 * static-HTML rows, where the transcript's delegated [data-copy] handler is
 * the only thing that runs.
 */
export function markInlineCopied(btn: HTMLElement): void {
  btn.dataset.copied = 'true';
  btn.setAttribute('aria-label', 'Copied');
  window.setTimeout(() => {
    btn.removeAttribute('data-copied');
    btn.setAttribute('aria-label', 'Copy');
  }, INLINE_COPY_RESET_MS);
}

// Trailing copy affordance for inline code. Pointer devices reveal it on hover
// or keyboard focus; touch devices (hover: none) keep it visible since there
// is no hover to reveal it with. The 12px icon sits in a 24px hit area so it
// is tappable on a phone. data-copy lets frozen (static-HTML) rows copy via
// the transcript's delegated click handler once this button has no React
// handler any more; live rows use onClick.
function InlineCodeCopyButton({ text }: { text: string }) {
  const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const btn = event.currentTarget;
    void handleInlineCopyClick(event, text).then((ok) => {
      if (ok) markInlineCopied(btn);
    });
  }, [text]);
  return (
    <button
      type="button"
      aria-label="Copy"
      data-copy={text}
      className="group/copy -my-1.5 ml-0.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded align-middle text-muted-foreground opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 data-[copied=true]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/inline-code:opacity-70"
      onClick={onClick}
    >
      <Copy aria-hidden="true" className="size-3 group-data-[copied=true]/copy:hidden" />
      <Check aria-hidden="true" className="hidden size-3 text-brand group-data-[copied=true]/copy:block" />
    </button>
  );
}

// An inline-code span that is one absolute local path becomes a link, so the
// transcript's delegated click handler opens it in the file preview exactly
// like [name](/abs/path). Every other span gets a small copy button. Fenced
// blocks never reach here (Streamdown routes them to its own code renderer,
// which Mermaid depends on, and which brings its own copy control).
function MarkdownInlineCode({ children, className, node: _node, ...props }: MarkdownCodeProps) {
  const link = typeof children === 'string' ? codePathLink(children) : null;
  if (link) {
    return (
      <a href={link.href} className="vp-file-path" data-file-path="">
        <code {...props} className={className}>{link.label}</code>
      </a>
    );
  }
  return (
    <code {...props} className={cn('group/inline-code', className)}>
      {children}
      <InlineCodeCopyButton text={renderedText(children)} />
    </code>
  );
}

function markdownLink(citations: Citation[]): Components['a'] {
  return function MarkdownLink({ children, href = '', node: _node, ...props }: MarkdownAnchorProps) {
    const label = renderedText(children);
    const citation = isCitationLabel(label) ? citationForHref(href, citations) : null;
    if (citation) {
      return (
        <a
          {...props}
          href={href}
          className="vp-citation-link"
          data-citation-number={citation.number}
          aria-label={`Open citation ${citation.number}: ${citation.title}`}
        >
          {citation.number}
        </a>
      );
    }
    if (isDesktopWatchLink(href)) {
      return (
        <a {...props} href={href} className="vp-watch-desktop" data-watch-desktop="">
          <Monitor aria-hidden="true" />
          <span>Watch live — agent&apos;s browser</span>
        </a>
      );
    }
    if (isPublishedPageLink(href)) {
      return (
        <a {...props} href={href} className="vp-page-link" data-page-link="">
          <AppWindow aria-hidden="true" />
          <span>{children}</span>
        </a>
      );
    }
    return <a {...props} href={href}>{children}</a>;
  };
}

function unescapedDelimiterAt(value: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function normalizeOutsideInlineCode(line: string, inlineTicks: { length: number }): string {
  let result = '';
  for (let index = 0; index < line.length;) {
    if (line[index] === '`' && unescapedDelimiterAt(line, index)) {
      let end = index + 1;
      while (line[end] === '`') end += 1;
      const runLength = end - index;
      if (inlineTicks.length === 0) inlineTicks.length = runLength;
      else if (inlineTicks.length === runLength) inlineTicks.length = 0;
      result += line.slice(index, end);
      index = end;
      continue;
    }
    if (
      inlineTicks.length === 0
      && line[index] === '\\'
      && unescapedDelimiterAt(line, index)
      && (line[index + 1] === '[' || line[index + 1] === ']'
        || line[index + 1] === '(' || line[index + 1] === ')')
    ) {
      const delimiter = line[index + 1];
      if (delimiter === '[' || delimiter === ']') {
        const currentLine = result.slice(result.lastIndexOf('\n') + 1);
        const remainder = line.slice(index + 2);
        if (currentLine.trim() !== '') result += '\n';
        result += '$$';
        if (remainder.trim() !== '') result += '\n';
      } else {
        result += '$$';
      }
      index += 2;
      continue;
    }
    result += line[index];
    index += 1;
  }
  return result;
}

/**
 * Accept the LaTeX delimiters agents commonly emit while leaving code alone.
 * Streamdown intentionally uses `$$` for both inline and display math so a
 * single dollar sign remains unambiguous currency.
 */
export function normalizeMathDelimiters(markdown: string): string {
  let result = '';
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  const inlineTicks = { length: 0 };

  while (offset < markdown.length) {
    const newline = markdown.indexOf('\n', offset);
    const end = newline === -1 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, end);
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(body);

    if (fence) {
      result += line;
      if (fenceMatch) {
        const run = fenceMatch[2]!;
        if (
          run[0] === fence.marker
          && run.length >= fence.length
          && fenceMatch[3]!.trim() === ''
        ) {
          fence = null;
        }
      }
    } else if (inlineTicks.length === 0 && fenceMatch) {
      const run = fenceMatch[2]!;
      fence = { marker: run[0] as '`' | '~', length: run.length };
      result += line;
    } else {
      result += normalizeOutsideInlineCode(line, inlineTicks);
    }
    offset = end;
  }

  return result;
}

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * A completed message that ends inside an open code fence is almost always a
 * fence mistake (typically a ``` nested inside another ```), not code: the
 * dangling fence would swallow every line after it into one code block.
 * Escape that last opening fence so the tail renders as ordinary markdown.
 * Streaming messages are left alone because an open fence mid-write is normal.
 */
export function escapeDanglingFence(markdown: string): string {
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number; start: number } | null = null;

  while (offset < markdown.length) {
    const newline = markdown.indexOf('\n', offset);
    const end = newline === -1 ? markdown.length : newline + 1;
    const body = markdown.slice(offset, newline === -1 ? end : newline);
    const match = FENCE_LINE.exec(body);
    if (match) {
      const run = match[2]!;
      if (fence) {
        if (run[0] === fence.marker && run.length >= fence.length && match[3]!.trim() === '') {
          fence = null;
        }
      } else {
        fence = { marker: run[0] as '`' | '~', length: run.length, start: offset + match[1]!.length };
      }
    }
    offset = end;
  }

  if (!fence) return markdown;
  return `${markdown.slice(0, fence.start)}\\${markdown.slice(fence.start)}`;
}

/** Shared GFM renderer for live chat, completed transcripts, and Markdown files. */
export const Markdown = memo(function Markdown({
  markdown,
  citations: citationsProp,
  mode = 'static',
}: {
  markdown: string;
  citations?: Citation[];
  mode?: MarkdownMode;
}) {
  const imageBaseUrl = useContext(MarkdownDocumentImageContext);
  const rehypePlugins = useMemo(() => {
    if (!imageBaseUrl) return Object.values(defaultRehypePlugins);
    // Harden resolves relative URLs against the website root. Route document
    // images first, while their paths still mean "relative to this report".
    // Streamdown caches processors by plugin name and JSON options. Include
    // the report URL in those options so switching reports cannot reuse it.
    const imagePlugin: [typeof routeDocumentImages, { imageBaseUrl: string }] = [routeDocumentImages, { imageBaseUrl }];
    return [defaultRehypePlugins.raw!, defaultRehypePlugins.sanitize!, imagePlugin, defaultRehypePlugins.harden!];
  }, [imageBaseUrl]);
  const citations = useMemo(
    () => citationsProp ?? extractCitations(markdown),
    [citationsProp, markdown],
  );
  const components = useMemo<Components>(
    () => ({ ...NATIVE_COMPONENTS, a: markdownLink(citations), inlineCode: MarkdownInlineCode }),
    [citations],
  );
  const rendered = useMemo(
    () => normalizeMathDelimiters(encodeLocalFileLinkTargets(
      mode === 'streaming' ? markdown : escapeDanglingFence(markdown),
    )),
    [markdown, mode],
  );
  const mermaidPointerStart = useRef<MermaidPointerStart | null>(null);
  const onPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    mermaidPointerStart.current = event.button === 0 && isMermaidChartTarget(event.target)
      ? {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          target: event.target,
        }
      : null;
  }, []);
  const onPointerUpCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = mermaidPointerStart.current;
    mermaidPointerStart.current = null;
    if (!start || !isMermaidTap(start, event)) return;
    if (openMermaidFullscreen(start.target)) event.preventDefault();
  }, []);
  const onPointerCancelCapture = useCallback(() => {
    mermaidPointerStart.current = null;
  }, []);

  return (
    <div
      className="vp-markdown"
      onPointerCancelCapture={onPointerCancelCapture}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
    >
      <Streamdown
        key={imageBaseUrl ?? 'chat'}
        className="prose-assistant space-y-0"
        components={components}
        controls={STREAMDOWN_CONTROLS}
        icons={STREAMDOWN_ICONS}
        isAnimating={mode === 'streaming'}
        lineNumbers={false}
        linkSafety={STREAMDOWN_LINK_SAFETY}
        mode={mode}
        plugins={STREAMDOWN_PLUGINS}
        rehypePlugins={rehypePlugins}
        remarkPlugins={STREAMDOWN_REMARK_PLUGINS}
      >
        {rendered}
      </Streamdown>
    </div>
  );
});
