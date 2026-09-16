interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export const PROJECT_SETTINGS_TOOL: AgentToolDefinition = {
  name: 'project_settings',
  description:
    "Read the effective project or site design, or update this chat's project settings. For page or app design, call with no arguments first so appearance is loaded only when relevant. New project instructions apply to new chats; existing chats keep their fixed snapshot. To update instructions, send the complete revised text; an empty string clears it. To update appearance, send only fields the user asked to change; omitted fields are preserved and empty strings reset them to site defaults. Only update on the user's explicit request. Unfiled chats can read site design but cannot update project settings.",
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        maxLength: 20000,
        description: 'Complete project instructions to save for new chats. Empty clears them. Omit to preserve them.',
      },
      appearance: {
        type: 'object',
        description: 'Appearance fields to update. Omit appearance entirely to read settings.',
        properties: {
          primaryColor: { type: 'string', description: 'Hex color (#rgb or #rrggbb), or empty to inherit.' },
          accentColor: { type: 'string', description: 'Hex color (#rgb or #rrggbb), or empty to inherit.' },
          backgroundColor: { type: 'string', description: 'Hex color (#rgb or #rrggbb), or empty to inherit.' },
          font: { type: 'string', description: 'Font family or stack, or empty to inherit.' },
          headingFont: { type: 'string', description: 'Heading font family or stack, or empty to inherit.' },
          notes: { type: 'string', description: 'Project style notes, or empty to inherit.' },
        },
        additionalProperties: false,
        minProperties: 1,
      },
    },
    additionalProperties: false,
  },
};

function appearanceLines(value: unknown): string[] {
  const appearance = (value ?? {}) as Record<string, unknown>;
  return [
    `  primaryColor: ${String(appearance.primaryColor ?? '') || '(inherit)'}`,
    `  accentColor: ${String(appearance.accentColor ?? '') || '(inherit)'}`,
    `  backgroundColor: ${String(appearance.backgroundColor ?? '') || '(inherit)'}`,
    `  font: ${String(appearance.font ?? '') || '(inherit)'}`,
    `  headingFont: ${String(appearance.headingFont ?? '') || '(inherit)'}`,
    `  notes: ${String(appearance.notes ?? '') || '(inherit)'}`,
  ];
}

function renderProjectSettings(settings: Record<string, unknown>, updated: boolean): string {
  const project = (settings.project ?? {}) as Record<string, unknown>;
  const instructions = String(settings.instructions ?? '');
  return [
    `${updated ? 'Updated' : 'Current'} ${project.name ? `shared project settings for ${String(project.name)}` : 'site design settings'}.`,
    '',
    'Project instructions:',
    instructions || '(none)',
    '',
    'Saved profile (empty fields inherit):',
    ...appearanceLines(settings.appearance),
    '',
    'Effective design:',
    ...appearanceLines(settings.effectiveAppearance),
    '',
    ...(settings.typographyGuidance ? [String(settings.typographyGuidance), ''] : []),
    ...(updated ? ['New chats will use the revised project instructions. Existing chats keep their fixed snapshot.', ''] : []),
    'Existing published pages and apps are unchanged.',
  ].join('\n');
}

export async function callProjectSettingsTool(
  args: Record<string, unknown>,
  callApi: CallApi,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const hasAppearance = Object.prototype.hasOwnProperty.call(args, 'appearance');
  const hasInstructions = Object.prototype.hasOwnProperty.call(args, 'instructions');
  const updating = hasAppearance || hasInstructions;
  if (hasAppearance) {
    const appearance = args.appearance;
    if (
      !appearance ||
      typeof appearance !== 'object' ||
      Array.isArray(appearance) ||
      Object.keys(appearance as Record<string, unknown>).length === 0
    ) {
      return {
        content: [{ type: 'text', text: 'Provide at least one appearance field to update, or omit appearance to read.' }],
        isError: true,
      };
    }
  }
  const patch: Record<string, unknown> = {};
  if (hasInstructions) patch.instructions = args.instructions;
  if (hasAppearance) patch.appearance = args.appearance;
  const { projectSettings } = (await callApi(
    '/api/project-settings',
    updating
      ? {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }
      : undefined,
  )) as { projectSettings: Record<string, unknown> };
  return { content: [{ type: 'text', text: renderProjectSettings(projectSettings, updating) }] };
}
