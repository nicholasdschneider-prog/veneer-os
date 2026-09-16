import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Provider-neutral deliverable-path extraction, shared by the Claude session
 * scanner (providers/claude/sessionFiles.ts), the Codex adapter's live capture
 * (providers/codexAppServer/adapter.ts), and the final-message link scan in
 * conversationManager.listSessionFiles. Everything here reports CANDIDATE
 * strings — callers verify existence/mtime before exposing anything.
 */

// Write/fileChange give an exact created path, so any watched *text* type is
// trusted (those tools only ever produce text — no binary formats belong
// here). Bash detection is a heuristic (a command token ending in a watched
// extension), so it sticks to formats a command plausibly generates as output
// and also covers the binary deliverables commands produce
// (pdf/docx/pptx/zip/images); .json is excluded there because `cat
// package.json`-style commands would false-match, and any stray mention is
// still guarded by the caller's mtime check.
export const WRITE_EXTS = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.json', '.html', '.svg']);
export const BASH_FILE_RE = /[\w.~/-]+\.(?:csv|tsv|xlsx?|pdf|docx|pptx|zip|png|jpe?g|svg|html|otf|ttf|woff2?|eot)\b/gi;
export const QUOTED_BASH_FILE_RE = /(["'])([^"'\r\n]{1,4096}\.(?:csv|tsv|xlsx?|pdf|docx|pptx|zip|png|jpe?g|svg|html|otf|ttf|woff2?|eot))\1/gi;

export const MAX_BASH_RESULT_BYTES = 256 * 1024;
export const MAX_BASH_RESULT_FILES = 128;

export function boundedResultText(text: string): string {
  const bytes = Buffer.from(text);
  const bounded = bytes.length > MAX_BASH_RESULT_BYTES ? bytes.subarray(0, MAX_BASH_RESULT_BYTES).toString('utf8') : text;
  // Terminal output commonly contains colors and cursor controls. Removing
  // those (plus NUL/other controls except whitespace) keeps path matching
  // deterministic and prevents one escape sequence from joining two tokens.
  return bounded
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '');
}

export function fileCandidates(text: string, limit = Number.POSITIVE_INFINITY): string[] {
  const candidates: { at: number; value: string; quoted: boolean; end: number }[] = [];
  const quotedSpans: { start: number; end: number }[] = [];

  for (const match of text.matchAll(QUOTED_BASH_FILE_RE)) {
    const value = match[2]?.trim();
    if (!value || match.index === undefined || /[$*?[\]{}]/.test(value)) continue;
    const end = match.index + match[0].length;
    quotedSpans.push({ start: match.index, end });
    candidates.push({ at: match.index, value, quoted: true, end });
  }
  for (const match of text.matchAll(BASH_FILE_RE)) {
    if (!match[0] || match.index === undefined) continue;
    if (quotedSpans.some((span) => match.index! >= span.start && match.index! < span.end)) continue;
    // `$out.pdf` is a producer signal but not a concrete filename. The linked
    // result supplies the expanded name; do not manufacture `/cwd/out.pdf`.
    if (match.index > 0 && text[match.index - 1] === '$') continue;
    // A URL is a reference, not a local deliverable path. `file://` input URLs
    // also start with // after the scheme is excluded by the regex.
    if (match[0].startsWith('//')) continue;
    candidates.push({ at: match.index, value: match[0], quoted: false, end: match.index + match[0].length });
  }

  candidates.sort((a, b) => a.at - b.at || Number(b.quoted) - Number(a.quoted));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { value } of candidates) {
    if (value.length > 4096 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

export function hasWatchedFileSignal(text: string): boolean {
  return Boolean(text.match(BASH_FILE_RE)?.length || text.match(QUOTED_BASH_FILE_RE)?.length);
}

// Local targets in an agent's reply. Markdown links and inline-code paths both
// count because agents commonly present a deliverable as `/absolute/path`.
// The target must then resolve to a local absolute path.
// Three target forms: the classic no-whitespace one, CommonMark's
// angle-bracket form for destinations with spaces ([x](</tmp/a b.csv>)), and
// plain targets containing raw spaces ([x](/tmp/a b.csv)) — agents emit those
// for paths like "/Users/…/Crew Seating/…", and dropping the deliverable over
// a space serves nobody. The absolute-path guard below keeps the
// space-tolerant match from picking up prose. An optional link title
// (`… "title"`) is dropped from either form.
const MARKDOWN_LINK_RE = /\]\((?:<([^<>\r\n]{1,4096})>(?:\s+"[^"]*")?|([^()\r\n]{1,4096}))\)/g;
const INLINE_CODE_RE = /(`+)([^`\r\n]{1,4096})\1/g;

const MAX_LINKED_FILES = 64;

/**
 * Local files the agent explicitly linked in a reply — the strongest
 * deliverable signal there is (the agent chose to present them to the user),
 * and the only one that is fully provider-neutral. Accepts absolute paths,
 * `~/` paths, and file:// URLs in markdown link targets; percent-encoding is
 * decoded (agents routinely URL-encode spaces in link hrefs). Anything else
 * (http links, relative paths) is ignored. Callers verify existence and apply
 * their heuristic-source mtime guard.
 */
/**
 * `home` may be a directory or a resolver. Callers with a real agent pass the
 * resolver, because which home a `~/…` link means depends on whether the agent
 * ran with Full Access.
 */
export function linkedFilePaths(markdown: string, home: string | ((input: string) => string)): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const remember = (rawTarget: string, plainLink = false): void => {
    if (result.length >= MAX_LINKED_FILES) return;
    let target = rawTarget.trim();
    // Plain-form targets may carry a trailing `"title"`; angle-form titles are
    // already excluded by the regex.
    if (plainLink) target = target.replace(/\s+"[^"]*"$/, '');
    // Editor locations describe where to open, not part of the filename.
    target = target.replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/i, '');
    if (target.startsWith('file:')) {
      try {
        target = fileURLToPath(target);
      } catch {
        return;
      }
    } else {
      try {
        target = decodeURIComponent(target);
      } catch {
        /* malformed encoding — keep the raw string */
      }
    }
    if (target.includes('\0')) return;
    if (target.startsWith('~/')) {
      target = typeof home === 'function' ? home(target) : path.join(home, target.slice(2));
    }
    if (!path.isAbsolute(target)) return;
    const normalized = path.normalize(target);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    remember(match[1] ?? match[2]!, match[1] === undefined);
    if (result.length >= MAX_LINKED_FILES) break;
  }
  for (const match of markdown.matchAll(INLINE_CODE_RE)) {
    remember(match[2]!);
    if (result.length >= MAX_LINKED_FILES) break;
  }
  return result;
}
