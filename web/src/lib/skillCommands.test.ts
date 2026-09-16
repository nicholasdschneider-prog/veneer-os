import { describe, expect, it } from 'vitest';
import type { SkillMeta, SkillScopeGroup, SkillsList } from './skills';
import {
  appendSkillInvocationMarker,
  availableSkillCommands,
  composerSkillForDraft,
  draftForComposerSkill,
  filterSkillCommands,
  skillNameForPrompt,
  skillQueryForDraft,
  splitSkillInvocationMarker,
} from './skillCommands';

function skill(name: string, scope: string, overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    scope,
    name,
    displayName: null,
    description: `${name} description`,
    providers: { claude: 'ok', codex: 'ok', grok: 'ok' },
    shared: true,
    enabled: true,
    origin: 'user',
    readOnly: false,
    issues: [],
    hasExtraFiles: false,
    mtime: 1,
    entryKind: 'original',
    source: null,
    dependents: [],
    ...overrides,
  };
}

function group(scope: string, label: string, skills: SkillMeta[]): SkillScopeGroup {
  return { scope, label, kind: scope === 'global' ? 'global' : scope === 'source' ? 'source' : 'project', root: '/skills', skills };
}

function list(scopes: SkillScopeGroup[], builtins: SkillMeta[] = []): SkillsList {
  return { ok: true, scopes, builtins };
}

describe('slash skill commands', () => {
  it('keeps only enabled, provider-readable placements in the active scope', () => {
    const result = availableSkillCommands(
      list([
        group('global', 'Global', [
          skill('global-skill', 'global'),
          skill('disabled', 'global', { enabled: false }),
          skill('claude-only', 'global', { providers: { claude: 'ok', codex: 'missing', grok: 'missing' } }),
        ]),
        group('project:here', 'Current project', [skill('project-skill', 'project:here')]),
        group('project:elsewhere', 'Other project', [skill('other-skill', 'project:elsewhere')]),
        group('source', 'Platform source', [skill('source-skill', 'source')]),
      ], [skill('built-in', 'builtin')]),
      { provider: 'codex', projectId: 'here', platformDev: false },
    );

    expect(result.map((command) => command.name)).toEqual(['built-in', 'global-skill', 'project-skill']);
    expect(result.map((command) => command.scopeLabel)).toEqual(['Built-in', 'Global', 'Current project']);
  });

  it('maps OpenRouter to Claude availability and includes source skills only for Platform Dev', () => {
    const skills = list([
      group('global', 'Global', [
        skill('claude-readable', 'global', { providers: { claude: 'ok', codex: 'missing', grok: 'missing' } }),
      ]),
      group('source', 'Platform source', [skill('source-skill', 'source')]),
    ]);

    expect(availableSkillCommands(skills, { provider: 'openrouter', projectId: null, platformDev: false }).map((c) => c.name))
      .toEqual(['claude-readable']);
    expect(availableSkillCommands(skills, { provider: 'openrouter', projectId: null, platformDev: true }).map((c) => c.name))
      .toEqual(['claude-readable', 'source-skill']);
  });

  it('flags duplicate eligible names instead of guessing precedence', () => {
    const result = availableSkillCommands(
      list([
        group('global', 'Global', [skill('review', 'global')]),
        group('project:here', 'Current project', [skill('review', 'project:here')]),
      ]),
      { provider: 'claude', projectId: 'here', platformDev: false },
    );

    expect(result).toEqual([{ name: 'review', description: 'review description', scopeLabel: 'Name conflict', conflict: true }]);
    expect(skillNameForPrompt('/review this', result)).toBeNull();
  });

  it('opens only for an unfinished leading token, filters descriptions, and limits results', () => {
    const commands = Array.from({ length: 10 }, (_, index) => ({
      name: `skill-${index}`,
      description: index === 9 ? 'Needle task' : 'Ordinary task',
      scopeLabel: 'Global',
      conflict: false,
    }));

    expect(skillQueryForDraft('/')).toBe('');
    expect(skillQueryForDraft('/SKILL-')).toBe('skill-');
    expect(skillQueryForDraft(' /skill')).toBeNull();
    expect(skillQueryForDraft('/skill request')).toBeNull();
    expect(filterSkillCommands(commands, '')).toHaveLength(8);
    expect(filterSkillCommands(commands, 'needle').map((command) => command.name)).toEqual(['skill-9']);
  });

  it('marks only exact available leading tokens and round-trips the visible prompt', () => {
    const commands = [{ name: 'review', description: null, scopeLabel: 'Global', conflict: false }];
    const visible = '/review this @Other chat\n\nMentioned chats (ids appended by the app):\n- @Other chat (chat id: abc)';
    const marked = appendSkillInvocationMarker(visible, skillNameForPrompt(visible, commands));

    expect(splitSkillInvocationMarker(marked)).toEqual({ visible, skillName: 'review' });
    expect(skillNameForPrompt('/reviewer this', commands)).toBeNull();
    expect(skillNameForPrompt('Please /review this', commands)).toBeNull();
    expect(splitSkillInvocationMarker('/other\n\n<!-- veneer-skill:review -->')).toEqual({
      visible: '/other\n\n<!-- veneer-skill:review -->',
      skillName: null,
    });
  });

  it('splits a selected skill from its textarea request without losing request content', () => {
    const review = { name: 'review', description: 'Review a plan', scopeLabel: 'Global', conflict: false };
    const draft = '/review Check this @Other chat\n\nKeep this spacing';

    expect(composerSkillForDraft(draft, [review])).toEqual({
      command: review,
      request: 'Check this @Other chat\n\nKeep this spacing',
    });
    expect(draftForComposerSkill(review, 'Check this @Other chat\n\nKeep this spacing')).toBe(draft);
  });

  it('leaves ordinary slash text and unavailable or conflicting skills unchanged', () => {
    const review = { name: 'review', description: null, scopeLabel: 'Global', conflict: false };
    const conflict = { ...review, conflict: true };

    expect(composerSkillForDraft('Please /review this', [review])).toBeNull();
    expect(composerSkillForDraft('/reviewer this', [review])).toBeNull();
    expect(composerSkillForDraft('/review this', [])).toBeNull();
    expect(composerSkillForDraft('/review this', [conflict])).toBeNull();
  });

  it('removes only one token separator so intentional request whitespace survives', () => {
    const review = { name: 'review', description: null, scopeLabel: 'Global', conflict: false };

    expect(composerSkillForDraft('/review  indented', [review])?.request).toBe(' indented');
    expect(composerSkillForDraft('/review\nnext line', [review])?.request).toBe('next line');
    expect(composerSkillForDraft('/review', [review])?.request).toBe('');
  });
});
