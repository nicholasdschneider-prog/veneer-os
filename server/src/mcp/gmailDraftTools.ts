export interface GmailDraftToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type CallApi = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export const GMAIL_DRAFT_TOOL: GmailDraftToolDefinition = {
  name: 'create_gmail_draft_with_attachments',
  description:
    'Create an unsent Gmail draft and attach one or more local deliverable files. Use this instead of a Gmail connector create-draft action whenever attachments are local paths, because this tool securely stages the files first. It never sends the message. If multiple Gmail accounts are available, provide the exact account label named in the error.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Optional exact Gmail connection label.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body: { type: 'string' },
      isHtml: { type: 'boolean', description: 'True only when body contains HTML.' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute paths, or paths relative to this chat workspace, for local files to attach.',
      },
    },
    required: ['to', 'subject', 'body', 'attachments'],
  },
};

export async function callGmailDraftTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: CallApi;
}): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  if (name !== GMAIL_DRAFT_TOOL.name) return null;
  const result = await callApi('/api/connectors/gmail/drafts-with-attachments', {
    method: 'POST',
    body: JSON.stringify(args),
  });
  const draft = result.draft as { attached?: number; gmailUrl?: string | null; sent?: boolean } | undefined;
  const lines = [
    `Gmail draft created with ${Number(draft?.attached ?? 0)} attachment(s).`,
    'Status: unsent',
  ];
  if (draft?.gmailUrl) lines.push(`Open draft: ${draft.gmailUrl}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
