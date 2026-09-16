export interface ProjectToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProjectToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

const CROSS_PROJECT_GUIDANCE =
  'A chat\'s project folder is fixed. To work in another project, start a new chat with handoff and pass the exact project id.';

export const PROJECT_TOOL_DEFINITIONS: ProjectToolDefinition[] = [
  {
    name: 'list_projects',
    description:
      'List Veneer projects with their exact ids, slugs, names, and folders. Use this native tool before targeting an existing project; never browse or automate the Veneer UI to discover projects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description:
      'Create a Veneer project natively; never use browser automation for project creation. A project is a durable workspace folder for new chats. custom root_dir widens the workspace location and must be supplied only when the user explicitly specifies that exact absolute folder; existing Veneer role and folder permission checks still apply.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name (required, 1-120 characters).' },
        instructions: {
          type: 'string',
          description: 'Optional durable project context for chats created after this project exists.',
        },
        root_dir: {
          type: 'string',
          description:
            'Optional exact absolute custom folder. Use only when the user explicitly requested this folder; omit for Veneer\'s managed project workspace.',
        },
      },
      required: ['name'],
    },
  },
];

function projectDetail(project: Record<string, unknown>): string {
  return [
    String(project.name ?? '(unnamed project)'),
    `Project id: ${String(project.id ?? '')}`,
    `Slug: ${String(project.slug ?? '')}`,
    `Folder: ${String(project.folder ?? project.rootDir ?? '(unavailable)')}`,
  ].join('\n');
}

export async function callProjectTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: CallApi;
}): Promise<ProjectToolResult | null> {
  if (!PROJECT_TOOL_DEFINITIONS.some((tool) => tool.name === name)) return null;

  if (name === 'list_projects') {
    const body = await callApi('/api/projects');
    const projects = Array.isArray(body.projects) ? (body.projects as Record<string, unknown>[]) : [];
    const listing = projects.length ? projects.map(projectDetail).join('\n\n') : '(no projects)';
    return {
      content: [{ type: 'text', text: `Veneer projects:\n\n${listing}\n\n${CROSS_PROJECT_GUIDANCE}` }],
    };
  }

  const projectName = String(args.name ?? '').trim();
  if (!projectName) {
    return {
      content: [{ type: 'text', text: 'create_project needs a project name.' }],
      isError: true,
    };
  }
  const input: Record<string, unknown> = { name: projectName };
  if (args.instructions !== undefined) input.instructions = String(args.instructions);
  if (args.root_dir !== undefined) input.rootDir = String(args.root_dir);
  const body = await callApi('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const project = (body.project ?? {}) as Record<string, unknown>;
  const projectId = String(project.id ?? '');
  return {
    content: [
      {
        type: 'text',
        text:
          `Created Veneer project.\n${projectDetail(project)}\n\n` +
          `${CROSS_PROJECT_GUIDANCE} Call handoff with project: "${projectId}".`,
      },
    ],
  };
}
