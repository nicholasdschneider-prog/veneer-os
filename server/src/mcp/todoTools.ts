export interface TodoToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TodoToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

const linkInputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['link', 'file'] },
    href: { type: 'string', description: 'URL or existing Veneer file path.' },
    label: { type: ['string', 'null'], description: 'Optional short label.' },
  },
  required: ['kind', 'href'],
};

export const TODO_TOOL_DEFINITIONS: TodoToolDefinition[] = [
  {
    name: 'list_todos',
    description:
      'List Veneer Todos and the exact category and project ids needed for later changes. Use this before an edit when the Todo id is unknown; never guess between matching titles.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['pending', 'active', 'done'] },
        query: {
          type: 'string',
          description: 'Optional title or notes search text.',
        },
        category_id: {
          type: ['string', 'null'],
          description: 'Exact category id; null means Inbox.',
        },
        project_id: {
          type: ['string', 'null'],
          description: 'Exact project id; null means no project.',
        },
      },
    },
  },
  {
    name: 'read_todo',
    description:
      'Read one Veneer Todo by its exact id, including full notes and link ids. Use list_todos first when the id is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: {
          type: 'string',
          description: 'Exact Todo id returned by list_todos or create_todo.',
        },
      },
      required: ['todo_id'],
    },
  },
  {
    name: 'create_todo',
    description:
      'Create one pending Veneer Todo. Omit category_id to use Inbox. Use exact category and project ids from list_todos. This writes directly to the native list and must not use browser automation.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required concise Todo title.' },
        notes: { type: 'string', description: 'Optional details.' },
        category_id: {
          type: ['string', 'null'],
          description: 'Exact category id; omit or null for Inbox.',
        },
        project_id: {
          type: ['string', 'null'],
          description: 'Exact project id; omit or null for no project.',
        },
        links: {
          type: 'array',
          items: linkInputSchema,
          description: 'Optional links or existing Veneer files.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_todo',
    description:
      'Safely edit one Veneer Todo by exact id. Omitted fields stay unchanged. Add or remove links incrementally so existing attachments remain safe. action complete marks it done; action reopen restores active when linked to a chat, otherwise pending. This tool cannot delete Todos or change internal conversation/sort fields.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Exact Todo id.' },
        title: { type: 'string' },
        notes: { type: 'string' },
        category_id: {
          type: ['string', 'null'],
          description: 'Exact category id; null moves to Inbox.',
        },
        project_id: {
          type: ['string', 'null'],
          description: 'Exact project id; only valid while pending.',
        },
        action: { type: 'string', enum: ['complete', 'reopen'] },
        links_add: { type: 'array', items: linkInputSchema },
        link_ids_remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact link ids from read_todo. Unknown ids are rejected.',
        },
      },
      required: ['todo_id'],
    },
  },
];

const TODO_BASE = '/api/todos';

function queryPath(base: string, args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (args.state !== undefined) params.set('state', String(args.state));
  if (args.query !== undefined && String(args.query).trim()) params.set('query', String(args.query).trim());
  if (args.category_id !== undefined)
    params.set('categoryId', args.category_id === null ? 'inbox' : String(args.category_id));
  if (args.project_id !== undefined)
    params.set('projectId', args.project_id === null ? 'none' : String(args.project_id));
  return params.size ? `${base}?${params}` : base;
}

function linkInputs(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value)
    ? value.map((entry) => {
        const link = (entry ?? {}) as Record<string, unknown>;
        const result: Record<string, unknown> = {
          kind: String(link.kind ?? ''),
          href: String(link.href ?? ''),
        };
        if (link.label !== undefined) result.label = link.label === null ? null : String(link.label);
        return result;
      })
    : [];
}

function todoLine(todo: Record<string, unknown>, full: boolean): string {
  const category = todo.categoryName ? String(todo.categoryName) : 'Inbox';
  const project = todo.projectName ? String(todo.projectName) : 'no project';
  const notes = String(todo.notes ?? '').trim();
  const shownNotes = full || notes.length <= 160 ? notes : `${notes.slice(0, 160)}…`;
  const links = Array.isArray(todo.links) ? (todo.links as Record<string, unknown>[]) : [];
  const lines = [
    `${String(todo.title ?? '(untitled)')} [${String(todo.state ?? '?')}]`,
    `Todo id: ${String(todo.id ?? '')}`,
    `Category: ${category}${todo.categoryId ? ` (${String(todo.categoryId)})` : ''}`,
    `Project: ${project}${todo.projectId ? ` (${String(todo.projectId)})` : ''}`,
  ];
  if (shownNotes) lines.push(`Notes: ${shownNotes}`);
  if (links.length) {
    lines.push(
      'Links:',
      ...links.map(
        (link) =>
          `- ${String(link.label ?? link.href ?? '')} — ${String(link.kind ?? 'link')} — ${String(link.href ?? '')} (link id: ${String(link.id ?? '')})`,
      ),
    );
  }
  return lines.join('\n');
}

function renderList(body: Record<string, unknown>): string {
  const todos = Array.isArray(body.todos) ? (body.todos as Record<string, unknown>[]) : [];
  const categories = Array.isArray(body.categories) ? (body.categories as Record<string, unknown>[]) : [];
  const projects = Array.isArray(body.projects) ? (body.projects as Record<string, unknown>[]) : [];
  const categoryLines = [
    'Inbox (category id: null)',
    ...categories.map((item) => `${String(item.name)} (${String(item.id)})`),
  ];
  const projectLines = projects.length
    ? projects.map((item) => `${String(item.name)} (${String(item.id)})`)
    : ['(none)'];
  const todoLines = todos.length ? todos.map((todo) => todoLine(todo, false)).join('\n\n') : '(no matching Todos)';
  return `Todos:\n\n${todoLines}\n\nCategories:\n${categoryLines.join('\n')}\n\nProjects:\n${projectLines.join('\n')}`;
}

export async function callTodoTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: CallApi;
}): Promise<TodoToolResult | null> {
  if (!TODO_TOOL_DEFINITIONS.some((tool) => tool.name === name)) return null;
  const base = TODO_BASE;
  if (name === 'list_todos') {
    const body = await callApi(queryPath(base, args));
    return { content: [{ type: 'text', text: renderList(body) }] };
  }
  const todoId = String(args.todo_id ?? '').trim();
  if (name === 'read_todo') {
    if (!todoId)
      return {
        content: [{ type: 'text', text: 'read_todo needs an exact todo_id.' }],
        isError: true,
      };
    const body = await callApi(`${base}/${encodeURIComponent(todoId)}`);
    return {
      content: [
        {
          type: 'text',
          text: todoLine((body.todo ?? {}) as Record<string, unknown>, true),
        },
      ],
    };
  }
  if (name === 'create_todo') {
    const title = String(args.title ?? '').trim();
    if (!title)
      return {
        content: [{ type: 'text', text: 'create_todo needs a title.' }],
        isError: true,
      };
    const input: Record<string, unknown> = { title };
    if (args.notes !== undefined) input.notes = String(args.notes);
    if (args.category_id !== undefined) input.categoryId = args.category_id === null ? null : String(args.category_id);
    if (args.project_id !== undefined) input.projectId = args.project_id === null ? null : String(args.project_id);
    if (args.links !== undefined) input.links = linkInputs(args.links);
    const body = await callApi(base, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      content: [
        {
          type: 'text',
          text: `Created Todo.\n${todoLine((body.todo ?? {}) as Record<string, unknown>, true)}`,
        },
      ],
    };
  }
  if (!todoId)
    return {
      content: [{ type: 'text', text: 'update_todo needs an exact todo_id.' }],
      isError: true,
    };
  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = String(args.title);
  if (args.notes !== undefined) input.notes = String(args.notes);
  if (args.category_id !== undefined) input.categoryId = args.category_id === null ? null : String(args.category_id);
  if (args.project_id !== undefined) input.projectId = args.project_id === null ? null : String(args.project_id);
  if (args.action !== undefined) input.action = String(args.action);
  if (args.links_add !== undefined) input.linksAdd = linkInputs(args.links_add);
  if (args.link_ids_remove !== undefined) {
    input.linkIdsRemove = Array.isArray(args.link_ids_remove) ? args.link_ids_remove.map(String) : [];
  }
  if (Object.keys(input).length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'Provide at least one Todo field or action to update.',
        },
      ],
      isError: true,
    };
  }
  const body = await callApi(`${base}/${encodeURIComponent(todoId)}/agent`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return {
    content: [
      {
        type: 'text',
        text: `Updated Todo.\n${todoLine((body.todo ?? {}) as Record<string, unknown>, true)}`,
      },
    ],
  };
}
