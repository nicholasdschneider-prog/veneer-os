import type Database from 'better-sqlite3';

export interface TodoPlanningSettings {
  prompt: string;
}

export const DEFAULT_TODO_PLANNING_PROMPT = `This chat was started from a to-do. This first turn is planning-only.

Do not execute or begin implementing the task in this turn. Do not edit, create, move, or delete files. Do not enqueue a build or run builds, tests, installs, generators, formatters, commits, pushes, shipping, deployments, or other external mutations.

Use this turn only to understand and refine the request. You may inspect and read relevant files, existing behavior, tests, or documentation. Then:
- Summarize your understanding of what the user wants.
- Surface important assumptions, constraints, risks, or decisions.
- Ask any necessary clarifying questions.

Do not proceed beyond planning until the user responds in a later turn.`;

export const MAX_TODO_PLANNING_PROMPT_LENGTH = 50_000;

export function todoPlanningSettingKey(userId: number | string): string {
  return `todo_planning_prompt:${String(userId)}`;
}

function normalizedSettings(value: unknown): TodoPlanningSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { prompt: DEFAULT_TODO_PLANNING_PROMPT };
  }
  const prompt = (value as Partial<TodoPlanningSettings>).prompt;
  return {
    prompt:
      typeof prompt === 'string' &&
      prompt.trim().length > 0 &&
      prompt.length <= MAX_TODO_PLANNING_PROMPT_LENGTH
        ? prompt
        : DEFAULT_TODO_PLANNING_PROMPT,
  };
}

export function readTodoPlanningSettings(
  db: Database.Database,
  userId: number | string,
): TodoPlanningSettings {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(todoPlanningSettingKey(userId)) as
    | { value_json: string }
    | undefined;
  if (!row) return { prompt: DEFAULT_TODO_PLANNING_PROMPT };
  try {
    return normalizedSettings(JSON.parse(row.value_json));
  } catch {
    return { prompt: DEFAULT_TODO_PLANNING_PROMPT };
  }
}

export function writeTodoPlanningSettings(
  db: Database.Database,
  userId: number | string,
  settings: TodoPlanningSettings,
): TodoPlanningSettings {
  const normalized = normalizedSettings(settings);
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(todoPlanningSettingKey(userId), JSON.stringify(normalized));
  return normalized;
}
