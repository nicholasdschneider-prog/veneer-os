import { describe, expect, it, vi } from 'vitest';
import { callProjectTool, PROJECT_TOOL_DEFINITIONS } from '../src/mcp/projectTools.js';

describe('native project agent tools', () => {
  it('exposes list and create without destructive project operations', () => {
    expect(PROJECT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['list_projects', 'create_project']);
    expect(PROJECT_TOOL_DEFINITIONS.map((tool) => tool.name)).not.toContain('delete_project');

    const create = PROJECT_TOOL_DEFINITIONS.find((tool) => tool.name === 'create_project')!;
    const properties = create.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['name', 'instructions', 'root_dir']);
    expect(create.description).toContain('never use browser automation');
    expect(create.description).toContain('user explicitly specifies that exact absolute folder');
  });

  it('lists exact project identity and resolved folders with cross-project guidance', async () => {
    const callApi = vi.fn(async () => ({
      ok: true,
      projects: [
        {
          id: 'project-1',
          slug: 'daily-donut',
          name: 'Daily Donut',
          rootDir: null,
          folder: '/srv/veneer/workspaces/projects/daily-donut',
        },
      ],
    }));

    const result = await callProjectTool({ name: 'list_projects', args: {}, callApi });

    expect(callApi).toHaveBeenCalledWith('/api/projects');
    expect(result?.content[0]?.text).toContain('Project id: project-1');
    expect(result?.content[0]?.text).toContain('Slug: daily-donut');
    expect(result?.content[0]?.text).toContain('Folder: /srv/veneer/workspaces/projects/daily-donut');
    expect(result?.content[0]?.text).toContain("A chat's project folder is fixed");
    expect(result?.content[0]?.text).toContain('handoff');
  });

  it('maps the safe creation fields to the existing authenticated project route', async () => {
    const callApi = vi.fn(async () => ({
      ok: true,
      project: {
        id: 'project-new',
        slug: 'daily-donut',
        name: 'Daily Donut',
        rootDir: '/Users/sam/Developer/Daily Donut',
        folder: '/Users/sam/Developer/Daily Donut',
      },
    }));

    const result = await callProjectTool({
      name: 'create_project',
      args: {
        name: '  Daily Donut  ',
        instructions: 'Keep version one small.',
        root_dir: '/Users/sam/Developer/Daily Donut',
      },
      callApi,
    });

    expect(callApi).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Daily Donut',
        instructions: 'Keep version one small.',
        rootDir: '/Users/sam/Developer/Daily Donut',
      }),
    });
    expect(result?.content[0]?.text).toContain('Created Veneer project.');
    expect(result?.content[0]?.text).toContain('Project id: project-new');
    expect(result?.content[0]?.text).toContain('Call handoff with project: "project-new"');
  });

  it('does not attempt a route call without a project name', async () => {
    const callApi = vi.fn();

    const result = await callProjectTool({ name: 'create_project', args: { name: '  ' }, callApi });

    expect(result?.isError).toBe(true);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('passes existing route authorization failures through unchanged', async () => {
    const denied = new Error('Account pending approval');
    const callApi = vi.fn(async () => {
      throw denied;
    });

    await expect(
      callProjectTool({
        name: 'create_project',
        args: { name: 'Denied', root_dir: '/restricted/project' },
        callApi,
      }),
    ).rejects.toBe(denied);
  });
});
