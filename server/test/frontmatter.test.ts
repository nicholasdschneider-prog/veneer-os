import { describe, expect, it } from 'vitest';
import { composeSkillMd, parseSkillMd, setBody, setScalars } from '../src/skills/frontmatter.js';

describe('frontmatter', () => {
  it('compose → parse round-trips name/description/body', () => {
    const raw = composeSkillMd('refunds', 'How to process refunds', 'Step 1. Ask for the order id.\n');
    const p = parseSkillMd(raw);
    expect(p.hasFrontmatter).toBe(true);
    expect(p.name).toBe('refunds');
    expect(p.description).toBe('How to process refunds');
    expect(p.body).toBe('\nStep 1. Ask for the order id.\n');
    expect(p.warnings).toEqual([]);
  });

  it('quotes/escapes descriptions with special characters', () => {
    const raw = composeSkillMd('x', 'He said "hi"\nand left: done', 'body');
    expect(parseSkillMd(raw).description).toBe('He said "hi"\nand left: done');
  });

  it('setScalars preserves unknown keys byte-for-byte', () => {
    const raw = [
      '---',
      'name: verify',
      'description: old text',
      'allowed-tools: Bash, Read',
      'metadata:',
      '  team: platform',
      'context: fork',
      '---',
      '',
      '# Body stays',
      '',
    ].join('\n');
    const out = setScalars(raw, { description: 'new text' });
    expect(out).toContain('allowed-tools: Bash, Read');
    expect(out).toContain('metadata:');
    expect(out).toContain('  team: platform');
    expect(out).toContain('context: fork');
    expect(out).toContain('# Body stays');
    const p = parseSkillMd(out);
    expect(p.description).toBe('new text');
    expect(p.name).toBe('verify');
  });

  it('setScalars rewrites the name line for rename', () => {
    const raw = composeSkillMd('old-name', 'desc', 'body\n');
    const out = setScalars(raw, { name: 'new-name' });
    expect(parseSkillMd(out).name).toBe('new-name');
    expect(parseSkillMd(out).description).toBe('desc');
  });

  it('setScalars inserts a missing key without disturbing existing lines', () => {
    const raw = ['---', 'name: only-name', '---', '', 'body'].join('\n');
    const out = setScalars(raw, { description: 'added' });
    const p = parseSkillMd(out);
    expect(p.name).toBe('only-name');
    expect(p.description).toBe('added');
    expect(p.body).toBe('\nbody');
  });

  it('setScalars synthesizes a frontmatter block when none exists', () => {
    const raw = '# Just a heading\n\nbody text\n';
    const out = setScalars(raw, { name: 'adopted', description: 'auto' });
    const p = parseSkillMd(out);
    expect(p.name).toBe('adopted');
    expect(p.description).toBe('auto');
    expect(p.body).toBe('\n# Just a heading\n\nbody text\n');
  });

  it('setBody leaves the frontmatter intact', () => {
    const raw = composeSkillMd('x', 'keep me', 'old body\n');
    const out = setBody(raw, 'brand new body');
    const p = parseSkillMd(out);
    expect(p.name).toBe('x');
    expect(p.description).toBe('keep me');
    expect(p.body).toBe('brand new body');
  });

  it('setBody round-trips a parsed body exactly', () => {
    const raw = composeSkillMd('x', 'd', 'multi\nline\nbody\n');
    const parsed = parseSkillMd(raw);
    expect(setBody(raw, parsed.body)).toBe(raw);
  });

  it('tolerates missing frontmatter → nulls + warning, never throws', () => {
    const p = parseSkillMd('# verify\n\nSome instructions with no frontmatter.\n');
    expect(p.hasFrontmatter).toBe(false);
    expect(p.name).toBeNull();
    expect(p.description).toBeNull();
    expect(p.warnings).toContain('no-frontmatter');
    expect(p.body).toBe('# verify\n\nSome instructions with no frontmatter.\n');
  });

  it('tolerates a frontmatter block missing description', () => {
    const p = parseSkillMd('---\nname: x\n---\n\nbody');
    expect(p.name).toBe('x');
    expect(p.description).toBeNull();
    expect(p.warnings).toContain('missing-description');
  });

  it('tolerates garbage / unterminated frontmatter without throwing', () => {
    const p = parseSkillMd('---\nname: x\nno closing delimiter here');
    expect(p.hasFrontmatter).toBe(false);
    expect(p.warnings).toContain('no-frontmatter');
  });

  it('parses single-quoted scalars', () => {
    const p = parseSkillMd("---\nname: x\ndescription: 'it''s fine'\n---\nbody");
    expect(p.description).toBe("it's fine");
  });

  it('sees through a leading UTF-8 BOM instead of reporting no-frontmatter', () => {
    const raw = '﻿---\nname: x\ndescription: d\n---\nbody';
    const p = parseSkillMd(raw);
    expect(p.hasFrontmatter).toBe(true);
    expect(p.name).toBe('x');
    // setScalars must edit the existing block, not prepend a second one.
    const out = setScalars(raw, { description: 'new' });
    expect(out.match(/^---$/gm)!.length).toBe(2);
    expect(out).toContain('description: "new"');
  });

  it('reads folded/literal block-scalar descriptions', () => {
    const p = parseSkillMd('---\nname: x\ndescription: >\n  a long\n  folded value\n---\nbody');
    expect(p.description).toBe('a long folded value');
  });

  it('rewriting a block-scalar description removes its continuation lines', () => {
    const raw = '---\nname: x\ndescription: >\n  long\n  desc\nlicense: MIT\n---\nbody';
    const out = setScalars(raw, { description: 'short' });
    expect(out).toBe('---\nname: x\ndescription: "short"\nlicense: MIT\n---\nbody');
  });
});
