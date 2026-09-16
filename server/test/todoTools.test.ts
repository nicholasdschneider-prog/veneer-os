import { describe, expect, it, vi } from 'vitest';
import { callTodoTool, TODO_TOOL_DEFINITIONS } from '../src/mcp/todoTools.js';

describe('native Todo agent tools', () => {
  it('exposes safe list/read/create/update tools without deletion or internal fields', () => {
    expect(TODO_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'list_todos',
      'read_todo',
      'create_todo',
      'update_todo',
    ]);
    const update = TODO_TOOL_DEFINITIONS.find((tool) => tool.name === 'update_todo')!;
    const properties = update.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('conversation_id');
    expect(properties).not.toHaveProperty('sort_order');
    expect(properties).not.toHaveProperty('state');
    for (const tool of TODO_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.properties as Record<string, unknown>).not.toHaveProperty('instance');
    }
  });

  it('lists Todos with exact Todo, category, and project ids', async () => {
    const callApi = vi.fn(async () => ({
      ok: true,
      categories: [{ id: 'category-1', name: 'Network' }],
      projects: [{ id: 'project-1', name: 'Acme' }],
      todos: [
        {
          id: 'todo-1',
          title: 'Replace switch',
          notes: 'Rack 2',
          state: 'pending',
          categoryId: 'category-1',
          categoryName: 'Network',
          projectId: 'project-1',
          projectName: 'Acme',
          links: [],
        },
      ],
    }));
    const result = await callTodoTool({
      name: 'list_todos',
      args: { state: 'pending', query: 'switch' },
      callApi,
    });
    expect(callApi).toHaveBeenCalledWith('/api/todos?state=pending&query=switch');
    expect(result?.content[0]?.text).toContain('Todo id: todo-1');
    expect(result?.content[0]?.text).toContain('Network (category-1)');
    expect(result?.content[0]?.text).toContain('Acme (project-1)');
  });

  it('creates a Todo on the local route and maps safe fields', async () => {
    const callApi = vi.fn(async () => ({
      ok: true,
      todo: {
        id: 'todo-new',
        title: 'Verify VLAN',
        state: 'pending',
        links: [],
      },
    }));
    await callTodoTool({
      name: 'create_todo',
      args: {
        title: 'Verify VLAN',
        notes: 'After migration',
        category_id: null,
        project_id: 'project-1',
        links: [{ kind: 'link', href: 'https://example.com/plan', label: 'Plan' }],
      },
      callApi,
    });
    const [path, init] = callApi.mock.calls[0]!;
    expect(path).toBe('/api/todos');
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'Verify VLAN',
      notes: 'After migration',
      categoryId: null,
      projectId: 'project-1',
      links: [{ kind: 'link', href: 'https://example.com/plan', label: 'Plan' }],
    });
  });

  it('uses the safe local update route and incremental link fields', async () => {
    const callApi = vi.fn(async () => ({
      ok: true,
      todo: { id: 'todo-1', title: 'Keep title', state: 'done', links: [] },
    }));
    await callTodoTool({
      name: 'update_todo',
      args: {
        todo_id: 'todo-1',
        action: 'complete',
        links_add: [{ kind: 'link', href: 'https://example.com' }],
        link_ids_remove: ['link-1'],
      },
      callApi,
    });
    expect(callApi).toHaveBeenCalledWith(
      '/api/todos/todo-1/agent',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          action: 'complete',
          linksAdd: [{ kind: 'link', href: 'https://example.com' }],
          linkIdsRemove: ['link-1'],
        }),
      }),
    );
  });
});
