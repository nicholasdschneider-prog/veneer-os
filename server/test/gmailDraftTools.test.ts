import { describe, expect, it, vi } from 'vitest';
import { callGmailDraftTool, GMAIL_DRAFT_TOOL, GMAIL_DRAFT_UPDATE_TOOL } from '../src/mcp/gmailDraftTools.js';

describe('Gmail draft attachment agent tool', () => {
  it('advertises an unsent local-file workflow and renders the safe result', async () => {
    expect(GMAIL_DRAFT_TOOL.name).toBe('create_gmail_draft_with_attachments');
    expect(GMAIL_DRAFT_TOOL.description).toContain('never sends');
    const callApi = vi.fn(async () => ({
      draft: { attached: 1, gmailUrl: 'https://mail.google.com/mail/u/0/#drafts/test', sent: false },
    }));

    const result = await callGmailDraftTool({
      name: GMAIL_DRAFT_TOOL.name,
      args: {
        to: ['owner@example.com'],
        subject: 'Test',
        body: 'Unsent',
        attachments: ['/tmp/report.csv'],
      },
      callApi,
    });

    expect(callApi).toHaveBeenCalledWith('/api/connectors/gmail/drafts-with-attachments', expect.objectContaining({
      method: 'POST',
    }));
    expect(result?.content[0]?.text).toContain('Status: unsent');
    expect(result?.content[0]?.text).toContain('Open draft: https://mail.google.com/');
  });

  it('updates an existing draft in place through the bridge route and reports it unsent', async () => {
    expect(GMAIL_DRAFT_UPDATE_TOOL.name).toBe('update_gmail_draft_attachments');
    expect(GMAIL_DRAFT_UPDATE_TOOL.description).toContain('never sends');
    expect(GMAIL_DRAFT_UPDATE_TOOL.inputSchema.required).toContain('draft_id');
    const callApi = vi.fn(async () => ({
      draft: { updated: true, draft_id: 'r-1', thread_id: 't-1', attached: 1, gmailUrl: null, sent: false },
    }));

    const result = await callGmailDraftTool({
      name: GMAIL_DRAFT_UPDATE_TOOL.name,
      args: { draft_id: 'r-1', to: ['a@example.com'], subject: 'S', body: 'B', attachments: ['x.png'] },
      callApi,
    });

    expect(callApi).toHaveBeenCalledWith('/api/connectors/gmail/drafts/update-attachments', expect.objectContaining({
      method: 'POST',
    }));
    expect(result?.content[0]?.text).toContain('Gmail draft r-1 updated in place with 1 attachment(s).');
    expect(result?.content[0]?.text).toContain('Thread: t-1');
    expect(result?.content[0]?.text).toContain('Status: unsent');
  });
});
