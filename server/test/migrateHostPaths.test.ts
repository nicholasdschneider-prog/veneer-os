import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs operator script, no types
import { claudeProjectKeyForCwd, planAliases, planRootDirRemap } from '../../scripts/migrate-host-paths.mjs';
import { claudeProjectKeyForCwd as serverKey } from '../src/providers/claude/transcript.js';

const PROJECTS = [
  { slug: 'example', root_dir: '/home/veneer/example' },
  { slug: 'netsuite', root_dir: '/home/veneer/netsuite' },
  { slug: 'veneer-pro', root_dir: '/home/veneer/veneer-pro' },
  { slug: 'elsewhere', root_dir: '/srv/elsewhere' },
  { slug: 'unrooted', root_dir: null },
];

const remapOpts = {
  oldPrefix: '/home/veneer',
  newPrefix: '/Users/you/veneer-pro-home',
  // veneer-pro did not move with the others — the checkout went into the monorepo.
  overrides: new Map([['/home/veneer/veneer-pro', '/Users/you/veneer-os']]),
};

describe('migrate-host-paths', () => {
  it('derives the same project key as the server does', () => {
    // The whole script is worthless if this ever drifts from transcript.ts.
    for (const cwd of ['/home/veneer/netsuite', '/Users/you/veneer-os', '/tmp/a b/c.d']) {
      expect(claudeProjectKeyForCwd(cwd)).toBe(serverKey(cwd));
    }
  });

  it('remaps roots under the old prefix and honours explicit overrides', () => {
    const plan = planRootDirRemap({ ...remapOpts, projects: PROJECTS });
    const bySlug = Object.fromEntries(plan.map((row) => [row.slug, row]));

    expect(bySlug.example.to).toBe('/Users/you/veneer-pro-home/example');
    expect(bySlug.netsuite.to).toBe('/Users/you/veneer-pro-home/netsuite');
    expect(bySlug['veneer-pro'].to).toBe('/Users/you/veneer-os');
    expect(bySlug['veneer-pro'].reason).toBe('explicit --map');

    // Untouched: outside the prefix, and no root at all.
    expect(bySlug.elsewhere.changed).toBe(false);
    expect(bySlug.elsewhere.to).toBe('/srv/elsewhere');
    expect(bySlug.unrooted.changed).toBe(false);
  });

  it('does not treat a sibling directory as being under the prefix', () => {
    const plan = planRootDirRemap({
      oldPrefix: '/home/veneer',
      newPrefix: '/new',
      projects: [{ slug: 'decoy', root_dir: '/home/veneer2/thing' }],
    });
    expect(plan[0].changed).toBe(false);
  });

  it('plans an alias only where transcripts exist and the new key is free', () => {
    const projectsDir = '/svc/.claude/projects';
    const present = new Set([
      path.join(projectsDir, '-home-veneer-netsuite'),
      path.join(projectsDir, '-home-veneer-veneer-pro'),
      path.join(projectsDir, '-Users-you-veneer-os'), // already aliased
    ]);
    const moves = planRootDirRemap({ ...remapOpts, projects: PROJECTS })
      .filter((row) => row.changed)
      .map((row) => ({ ...row, label: `project:${row.slug}` }));

    const aliases = planAliases({ moves, projectsDir, exists: (p: string) => present.has(p) });
    const byNewKey = Object.fromEntries(aliases.map((a: { newKey: string }) => [a.newKey, a]));

    expect(byNewKey['-Users-you-veneer-pro-home-netsuite'].status).toBe('create');
    expect(byNewKey['-Users-you-veneer-pro-home-netsuite'].oldKey).toBe('-home-veneer-netsuite');
    // example has no transcript directory, so aliasing it would create a dangling link.
    expect(byNewKey['-Users-you-veneer-pro-home-example'].status).toBe('no-transcripts');
    // Re-running must not try to create a link that is already there.
    expect(byNewKey['-Users-you-veneer-os'].status).toBe('already-present');
  });

  it('is a no-op for a move that does not change the key', () => {
    const aliases = planAliases({
      moves: [{ label: 'same', from: '/a/b', to: '/a/b' }],
      projectsDir: '/p',
      exists: () => true,
    });
    expect(aliases).toEqual([]);
  });
});
