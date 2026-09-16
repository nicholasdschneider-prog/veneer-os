import { requestJson } from './api';

// Wire types — mirrored verbatim from the server (see skills spec §4).

export type ProviderState = 'ok' | 'missing' | 'broken-link';
export type SkillOrigin = 'user' | 'platform' | 'system' | 'broken';

export interface SkillProviders {
  claude: ProviderState;
  codex: ProviderState;
  grok: ProviderState;
}

export interface SkillPlacementRef {
  scope: string;
  name: string;
}

export interface SkillMeta {
  scope: string; // 'global' | 'source' | 'project:<id>'
  name: string; // dir name = identity = /command name
  displayName: string | null; // frontmatter name if present & differs from dir
  description: string | null; // null if absent/unparseable
  providers: SkillProviders;
  shared: boolean; // every provider is 'ok'
  enabled: boolean; // false = parked in holding dir
  origin: SkillOrigin; // 'platform' and 'system' => readOnly
  readOnly: boolean;
  issues: string[]; // 'no-frontmatter'|'missing-description'|'name-mismatch'|'broken-link:claude'|'broken-link:codex'|'name-clash'
  hasExtraFiles: boolean; // files besides SKILL.md
  mtime: number;
  entryKind: 'original' | 'link';
  source: SkillPlacementRef | null;
  dependents: SkillPlacementRef[];
}

export interface SkillDetail extends SkillMeta {
  content: string; // full raw SKILL.md
  body: string; // markdown after frontmatter
  extraFiles: string[]; // relative names, for the delete dialog
  canonicalDir: string; // absolute real-dir path (debug/advanced)
}

export interface SkillScopeGroup {
  scope: string;
  label: string;
  kind: 'global' | 'project' | 'source';
  root: string; // absolute base (for advanced display)
  skills: SkillMeta[];
}

export interface SkillsList {
  ok: boolean;
  scopes: SkillScopeGroup[];
  builtins: SkillMeta[];
}

export interface CreateSkillBody {
  name: string;
  description: string;
  body?: string;
}

// Save is form OR raw; exactly one shape (raw wins if present).
export interface SaveSkillBody {
  description?: string;
  body?: string;
  raw?: string;
  expectedMtime?: number;
}

export interface PatchSkillBody {
  newName?: string;
  enabled?: boolean;
}

const enc = encodeURIComponent;

export const skillsApi = {
  list: () => requestJson<SkillsList>('/api/skills'),
  read: (scope: string, name: string) =>
    requestJson<{ skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}`),
  create: (scope: string, body: CreateSkillBody) =>
    requestJson<{ skill: SkillDetail; crossScopeDuplicates?: string[] }>(`/api/skills/${enc(scope)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  save: (scope: string, name: string, body: SaveSkillBody) =>
    requestJson<{ skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  patch: (scope: string, name: string, body: PatchSkillBody) =>
    requestJson<{ skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  sync: (scope: string, name: string) =>
    requestJson<{ skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}/sync`, { method: 'POST' }),
  remove: (scope: string, name: string) =>
    requestJson<{ ok: boolean }>(`/api/skills/${enc(scope)}/${enc(name)}`, { method: 'DELETE' }),
  // MOVE the canonical folder to another scope ("make global"). One canonical folder stays the rule.
  move: (scope: string, name: string, toScope: string) =>
    requestJson<{ ok: boolean; skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}/move`, {
      method: 'POST',
      body: JSON.stringify({ toScope }),
    }),
  // COPY the whole folder into another scope (an intentional fork).
  copy: (scope: string, name: string, toScope: string) =>
    requestJson<{ ok: boolean; skill: SkillDetail }>(`/api/skills/${enc(scope)}/${enc(name)}/copy`, {
      method: 'POST',
      body: JSON.stringify({ toScope }),
    }),
};

// ---- Client-side aggregation (v2 skill-first list) ----

/** A skill identified by name, with every placement (scope) it exists in. */
export interface AggregatedSkill {
  name: string;
  description: string | null; // first non-null across placements
  placements: SkillMeta[];
  global: boolean; // has a global-scope placement
  projectCount: number; // number of project-scope placements
  issues: string[]; // union of every placement's issues
  enabledAnywhere: boolean;
}

/**
 * Group a scopes list by skill name. Builtins stay separate (they are not in
 * `list.scopes`). Sorted by name.
 */
export function groupByName(list: SkillsList): AggregatedSkill[] {
  const byName = new Map<string, SkillMeta[]>();
  for (const group of list.scopes) {
    for (const s of group.skills) {
      const arr = byName.get(s.name);
      if (arr) arr.push(s);
      else byName.set(s.name, [s]);
    }
  }
  const out: AggregatedSkill[] = [];
  for (const [name, placements] of byName) {
    out.push({
      name,
      description: placements.find((p) => p.description)?.description ?? null,
      placements,
      global: placements.some((p) => p.scope === 'global'),
      projectCount: placements.filter((p) => p.scope.startsWith('project:')).length,
      issues: [...new Set(placements.flatMap((p) => p.issues))],
      enabledAnywhere: placements.some((p) => p.enabled),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Merge provider availability across placements — 'ok' only if every placement is ok. */
export function mergeProviders(placements: SkillMeta[]): SkillProviders {
  const merge = (key: keyof SkillProviders): ProviderState => {
    if (placements.length && placements.every((p) => p.providers[key] === 'ok')) return 'ok';
    if (placements.some((p) => p.providers[key] === 'broken-link')) return 'broken-link';
    return 'missing';
  };
  return { claude: merge('claude'), codex: merge('codex'), grok: merge('grok') };
}
