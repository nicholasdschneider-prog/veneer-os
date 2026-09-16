import type { Provider } from './modelLabel';
import type { SkillMeta, SkillProviders, SkillsList } from './skills';

export interface SkillCommand {
  name: string;
  description: string | null;
  scopeLabel: string;
  conflict: boolean;
}

export interface ComposerSkill {
  command: SkillCommand;
  request: string;
}

const SKILL_MARKER = '\n\n<!-- veneer-skill:';
const SKILL_NAME = '[a-z0-9][a-z0-9-]*';

function providerKey(provider: Provider): keyof SkillProviders {
  return provider === 'openrouter' ? 'claude' : provider;
}

function placementLabel(skill: SkillMeta, groupLabel: string): string {
  if (skill.scope === 'global') return 'Global';
  if (skill.scope === 'source') return 'Platform source';
  return groupLabel;
}

export function availableSkillCommands(
  list: SkillsList | null,
  options: { provider: Provider | null; projectId: string | null; platformDev: boolean },
): SkillCommand[] {
  if (!list?.ok || !options.provider) return [];
  const key = providerKey(options.provider);
  const placements: Array<{ skill: SkillMeta; label: string }> = [];
  const eligible = (skill: SkillMeta) => skill.enabled && skill.providers[key] === 'ok';

  for (const group of list.scopes) {
    const inScope =
      group.scope === 'global' ||
      (options.projectId !== null && group.scope === `project:${options.projectId}`) ||
      (options.platformDev && group.scope === 'source');
    if (!inScope) continue;
    for (const skill of group.skills) {
      if (eligible(skill)) placements.push({ skill, label: placementLabel(skill, group.label) });
    }
  }
  for (const skill of list.builtins) {
    if (eligible(skill)) placements.push({ skill, label: 'Built-in' });
  }

  const byName = new Map<string, Array<{ skill: SkillMeta; label: string }>>();
  for (const placement of placements) {
    const normalized = placement.skill.name.toLowerCase();
    const matches = byName.get(normalized);
    if (matches) matches.push(placement);
    else byName.set(normalized, [placement]);
  }

  return [...byName.entries()]
    .map(([name, matches]) => ({
      name,
      description: matches.find(({ skill }) => skill.description)?.skill.description ?? null,
      scopeLabel: matches.length > 1 ? 'Name conflict' : matches[0]!.label,
      conflict: matches.length > 1,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The picker is intentionally limited to the first, still-unfinished token. */
export function skillQueryForDraft(draft: string): string | null {
  return /^\/([a-z0-9-]*)$/i.exec(draft)?.[1]?.toLowerCase() ?? null;
}

export function filterSkillCommands(commands: SkillCommand[], query: string, limit = 8): SkillCommand[] {
  const needle = query.toLowerCase();
  return commands
    .filter((command) => `${command.name} ${command.description ?? ''}`.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Return an eligible invocation only for an exact leading `/name` token. */
export function skillNameForPrompt(text: string, commands: SkillCommand[]): string | null {
  const match = new RegExp(`^/(${SKILL_NAME})(?=\\s|$)`, 'i').exec(text);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  return commands.some((command) => command.name === name && !command.conflict) ? name : null;
}

/** Split an eligible leading invocation from the request shown in the textarea. */
export function composerSkillForDraft(draft: string, commands: SkillCommand[]): ComposerSkill | null {
  const name = skillNameForPrompt(draft, commands);
  if (!name) return null;
  const command = commands.find((candidate) => candidate.name === name && !candidate.conflict);
  if (!command) return null;
  const afterToken = draft.slice(name.length + 1);
  return {
    command,
    request: /^\s/.test(afterToken) ? afterToken.slice(1) : afterToken,
  };
}

/** Keep the durable draft provider-neutral while the textarea shows only the request. */
export function draftForComposerSkill(command: SkillCommand, request: string): string {
  return `/${command.name} ${request}`;
}

export function appendSkillInvocationMarker(text: string, name: string | null): string {
  return name ? `${text}${SKILL_MARKER}${name} -->` : text;
}

/** Strip only a final, well-formed marker that matches the leading token. */
export function splitSkillInvocationMarker(text: string): { visible: string; skillName: string | null } {
  const marker = new RegExp(`${SKILL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${SKILL_NAME}) -->$`);
  const marked = marker.exec(text);
  if (!marked) return { visible: text, skillName: null };
  const visible = text.slice(0, marked.index);
  const leading = new RegExp(`^/(${SKILL_NAME})(?=\\s|$)`, 'i').exec(visible)?.[1]?.toLowerCase();
  return leading === marked[1]
    ? { visible, skillName: marked[1]! }
    : { visible: text, skillName: null };
}
