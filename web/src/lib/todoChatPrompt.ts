export const DEFAULT_TODO_PLANNING_PROMPT = `This chat was started from a to-do. This first turn is planning-only.

Do not execute or begin implementing the task in this turn. Do not edit, create, move, or delete files. Do not enqueue a build or run builds, tests, installs, generators, formatters, commits, pushes, shipping, deployments, or other external mutations.

Use this turn only to understand and refine the request. You may inspect and read relevant files, existing behavior, tests, or documentation. Then:
- Summarize your understanding of what the user wants.
- Surface important assumptions, constraints, risks, or decisions.
- Ask any necessary clarifying questions.

Do not proceed beyond planning until the user responds in a later turn.`;

/**
 * Wrap an editable to-do draft with first-turn-only planning constraints.
 * Keep the request first because the server uses its first line as the chat's
 * initial title (and may send the full message to the optional auto-titler).
 */
export function todoPlanningPrompt(
  request: string,
  planningPrompt = DEFAULT_TODO_PLANNING_PROMPT,
): string {
  return `${request}

---

${planningPrompt}`;
}

/** Apply the planning envelope only to a new chat carrying a source to-do. */
export function newChatSubmissionPrompt(
  request: string,
  todoId: string | null,
  planningPrompt = DEFAULT_TODO_PLANNING_PROMPT,
): string {
  return todoId ? todoPlanningPrompt(request, planningPrompt) : request;
}

/** Route a todo into a new chat, carrying its selected project when present. */
export function todoNewChatHash(todoId: string, projectId: string | null): string {
  const params = new URLSearchParams({ todo: todoId });
  if (projectId) params.set('project', projectId);
  return `#/chat/new?${params.toString()}`;
}
