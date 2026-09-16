/**
 * Percent-encode raw spaces in markdown link targets that point at local
 * files ([x](/Users/a b/c.dmg), file:// or ~/ targets). CommonMark parsers
 * refuse whitespace in a bare link destination, so without
 * this rewrite such links render as plain text and the deliverable is
 * unreachable from the transcript. Server-side detection
 * (fileScan.linkedFilePaths) already accepts these raw targets; this keeps
 * the chat body in step. Web URLs and relative paths are left untouched, and
 * a trailing `"title"` is preserved outside the encoded target.
 */
export function encodeLocalFileLinkTargets(markdown: string): string {
  return markdown.replace(
    /\]\(((?:file:\/\/|~\/|\/)[^()\r\n]{1,4096})\)/g,
    (whole, rawTarget: string) => {
      if (!/\s/.test(rawTarget)) return whole;
      const trimmed = rawTarget.trim();
      const title = trimmed.match(/\s+"[^"]*"$/)?.[0] ?? '';
      const target = title ? trimmed.slice(0, -title.length) : trimmed;
      if (!/\s/.test(target)) return `](${target}${title})`;
      return `](${target.replaceAll(' ', '%20')}${title})`;
    },
  );
}

// Same roots artifacts.ts accepts for same-origin path links; a bare span
// like `/Users/x/report.md` should open exactly like [report.md](/Users/x/report.md).
const CODE_PATH_ROOT_RE = /^(?:file:\/\/\/|~\/|\/(?:Users|home|root|tmp|private|var|opt|srv|mnt|data|workspaces?)\/)/;
// Characters that mean the span is a shell fragment, glob, or several tokens,
// not one file path: `/Users/x/run.py --flag`, `/tmp/*.log`, `a | b`.
const CODE_PATH_REJECT_RE = /[\r\n\t|<>*?"'`$;&]|\s-|\s\//;

export interface CodePathLink {
  /** Decoded path shown to the reader. */
  label: string;
  /** Link target the transcript click handler already understands. */
  href: string;
}

/**
 * Treat an inline-code span holding one absolute local path as a file link.
 * Agents habitually write `/Users/x/out/report.md` (sometimes %20-encoded)
 * instead of a markdown link, which rendered as inert text. Returns null for
 * anything that is not plainly a single path.
 */
export function codePathLink(text: string): CodePathLink | null {
  const raw = text.trim();
  if (!raw || raw.length > 4096 || !CODE_PATH_ROOT_RE.test(raw)) return null;
  let label = raw;
  if (raw.includes('%')) {
    try {
      label = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  if (CODE_PATH_REJECT_RE.test(label) || label.endsWith('/')) return null;
  return { label, href: label.replaceAll(' ', '%20') };
}
