/**
 * Byte-preserving SKILL.md frontmatter helpers (spec §5.1). Dependency-free —
 * NO YAML package. We only ever touch the flat, single-line `name:`/`description:`
 * scalars; every other frontmatter line (`allowed-tools`, `metadata:` blocks,
 * `context: fork`, `license`, …) round-trips untouched, and the markdown body is
 * preserved exactly. None of these functions throw on malformed input.
 *
 * Frontmatter is detected only as a leading `---` line … closing `---` line
 * block. Splitting on '\n' and re-joining is byte-exact (a trailing '\r' from a
 * CRLF file stays attached to its line), so unmodified lines survive verbatim.
 */

export interface ParsedSkill {
  name: string | null;
  description: string | null;
  body: string;
  hasFrontmatter: boolean;
  warnings: string[];
}

/** A leading '---' (with optional trailing spaces / CR) delimiter line. */
function isDelim(line: string): boolean {
  return /^---[ \t]*\r?$/.test(line) || line === '---';
}

interface Located {
  hasFrontmatter: boolean;
  lines: string[];
  /** Index of the closing '---' line (open is always 0). Only when hasFrontmatter. */
  closeIndex: number;
}

/** A leading UTF-8 BOM would hide the opening '---'; drop it (never re-added). */
function stripBom(raw: string): string {
  return raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
}

/** Find the leading frontmatter block, if any. */
function locate(raw: string): Located {
  const lines = raw.split('\n');
  if (lines.length === 0 || !isDelim(lines[0]!)) return { hasFrontmatter: false, lines, closeIndex: -1 };
  for (let i = 1; i < lines.length; i++) {
    if (isDelim(lines[i]!)) return { hasFrontmatter: true, lines, closeIndex: i };
  }
  return { hasFrontmatter: false, lines, closeIndex: -1 };
}

/** `>`/`|` block-scalar indicator (with optional chomp/indent suffix). */
function isBlockScalar(value: string): boolean {
  return /^[>|][+-]?[0-9]*$/.test(value.trim());
}

/** Unquote a simple single-line YAML scalar; leaves bare values as-is. */
function unquoteScalar(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** A top-level (no leading whitespace → not nested) `key:` line matcher. */
function scalarRe(key: string): RegExp {
  return new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*\\r?$`);
}

export function parseSkillMd(raw: string): ParsedSkill {
  raw = stripBom(raw);
  const loc = locate(raw);
  if (!loc.hasFrontmatter) {
    return { name: null, description: null, body: raw, hasFrontmatter: false, warnings: ['no-frontmatter'] };
  }
  // A `key: >` / `key: |` block scalar continues on the following indented
  // lines; read them so the value isn't reported as a bare ">".
  const readValue = (i: number, rawValue: string): string => {
    if (!isBlockScalar(rawValue)) return unquoteScalar(rawValue);
    const parts: string[] = [];
    for (let j = i + 1; j < loc.closeIndex && /^[ \t]/.test(loc.lines[j]!); j++) parts.push(loc.lines[j]!.trim());
    return parts.join(rawValue.trim().startsWith('>') ? ' ' : '\n').trim();
  };
  const warnings: string[] = [];
  let name: string | null = null;
  let description: string | null = null;
  for (let i = 1; i < loc.closeIndex; i++) {
    const line = loc.lines[i]!;
    let m = scalarRe('name').exec(line);
    if (m && name === null) {
      const v = readValue(i, m[1]!);
      name = v.length ? v : null;
      continue;
    }
    m = scalarRe('description').exec(line);
    if (m && description === null) {
      const v = readValue(i, m[1]!);
      description = v.length ? v : null;
    }
  }
  if (name === null) warnings.push('missing-name');
  if (description === null) warnings.push('missing-description');
  const body = loc.lines.slice(loc.closeIndex + 1).join('\n');
  return { name, description, body, hasFrontmatter: true, warnings };
}

/** Double-quoted YAML scalar (JSON string form is a valid YAML flow scalar). */
function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

export function composeSkillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${quoteYaml(description)}\n---\n\n${body}`;
}

/**
 * Rewrite only the `name:`/`description:` lines, preserving every other byte.
 * Missing keys are inserted just before the closing delimiter; a file with no
 * frontmatter gains a synthesized block ahead of its (all-body) content.
 */
export function setScalars(raw: string, changes: { name?: string; description?: string }): string {
  raw = stripBom(raw);
  const render = (key: 'name' | 'description', value: string): string =>
    key === 'description' ? `description: ${quoteYaml(value)}` : `name: ${value}`;

  const loc = locate(raw);
  if (!loc.hasFrontmatter) {
    const parts: string[] = [];
    if (changes.name !== undefined) parts.push(render('name', changes.name));
    if (changes.description !== undefined) parts.push(render('description', changes.description));
    if (parts.length === 0) return raw;
    return `---\n${parts.join('\n')}\n---\n\n${raw}`;
  }

  const lines = loc.lines;
  let closeIndex = loc.closeIndex;
  const setOne = (key: 'name' | 'description', value: string): void => {
    const re = scalarRe(key);
    for (let i = 1; i < closeIndex; i++) {
      const line = lines[i]!;
      const m = re.exec(line);
      if (m) {
        lines[i] = render(key, value) + (line.endsWith('\r') ? '\r' : '');
        // Rewriting a `key: >` / `key: |` block scalar must also take its
        // indented continuation lines, or they'd survive as stray frontmatter.
        if (isBlockScalar(m[1]!)) {
          let end = i + 1;
          while (end < closeIndex && /^[ \t]/.test(lines[end]!)) end++;
          lines.splice(i + 1, end - (i + 1));
          closeIndex -= end - (i + 1);
        }
        return;
      }
    }
    lines.splice(closeIndex, 0, render(key, value));
    closeIndex++;
  };
  if (changes.name !== undefined) setOne('name', changes.name);
  if (changes.description !== undefined) setOne('description', changes.description);
  return lines.join('\n');
}

/** Replace everything after the frontmatter block with `\n<body>` (frontmatter untouched). */
export function setBody(raw: string, body: string): string {
  raw = stripBom(raw);
  const loc = locate(raw);
  if (!loc.hasFrontmatter) return body;
  const frontmatter = loc.lines.slice(0, loc.closeIndex + 1).join('\n');
  return `${frontmatter}\n${body}`;
}
