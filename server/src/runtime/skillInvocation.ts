import type { ProviderId } from '../providers/types.js';

const SKILL_MARKER = '\n\n<!-- veneer-skill:';
const SKILL_NAME = '[a-z0-9][a-z0-9-]*';

export function splitSkillInvocation(text: string): { visible: string; skillName: string | null } {
  const marker = new RegExp(`${SKILL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${SKILL_NAME}) -->$`);
  const marked = marker.exec(text);
  if (!marked) return { visible: text, skillName: null };
  const visible = text.slice(0, marked.index);
  const leading = new RegExp(`^/(${SKILL_NAME})(?=\\s|$)`, 'i').exec(visible)?.[1]?.toLowerCase();
  return leading === marked[1]
    ? { visible, skillName: marked[1]! }
    : { visible: text, skillName: null };
}

export function providerSkillPrompt(
  provider: ProviderId,
  text: string,
): { visible: string; prompt: string; skillName: string | null } {
  const parsed = splitSkillInvocation(text);
  if (!parsed.skillName || provider !== 'codex') {
    return { visible: parsed.visible, prompt: parsed.visible, skillName: parsed.skillName };
  }
  return {
    visible: parsed.visible,
    prompt: parsed.visible.replace(new RegExp(`^/${parsed.skillName}(?=\\s|$)`, 'i'), `$${parsed.skillName}`),
    skillName: parsed.skillName,
  };
}
