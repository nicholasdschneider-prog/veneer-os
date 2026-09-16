import { describe, expect, it, vi } from 'vitest';
import { callGmailDraftTool, GMAIL_DRAFT_TOOL } from '../src/mcp/gmailDraftTools.js';

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
});
