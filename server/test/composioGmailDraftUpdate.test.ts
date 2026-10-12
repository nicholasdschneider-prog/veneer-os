import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@composio/core', () => ({
  Composio: class {
    files = { upload: mock.upload };
    sessions = { use: async () => ({ execute: mock.execute }) };
  },
}));

const { updateComposioGmailDraft } = await import('../src/connectors/composio.js');

const input = {
  draftId: 'r-1',
  to: ['claims@example.com', 'second@example.com'],
  cc: ['cc@example.com'],
  subject: 'Re: Claim',
  body: 'Exact body.',
  attachmentPaths: ['/work/out/proof.png'],
};

function draft(labelIds: string[], threadId = 'thread-existing') {
  return { data: { id: 'r-1', message: { id: 'm-1', threadId, labelIds } } };
}

beforeEach(() => {
  mock.execute.mockReset();
  mock.upload.mockReset();
  mock.upload.mockResolvedValue({ name: 'generated', mimetype: 'application/octet-stream', s3key: 'k/1' });
});

describe('updateComposioGmailDraft', () => {
  it('stages for GMAIL_UPDATE_DRAFT and replaces the draft in place, keeping its thread, without sending', async () => {
    mock.execute.mockImplementation(async (slug: string) =>
      slug === 'GMAIL_GET_DRAFT' ? draft(['DRAFT']) : { data: { id: 'r-1' } });

    const result = await updateComposioGmailDraft('key', 'session', input);

    expect(mock.upload).toHaveBeenCalledWith({
      file: '/work/out/proof.png', toolSlug: 'GMAIL_UPDATE_DRAFT', toolkitSlug: 'gmail',
    });
    expect(mock.execute.mock.calls.map(([slug]) => slug)).toEqual(['GMAIL_GET_DRAFT', 'GMAIL_UPDATE_DRAFT']);
    expect(mock.execute.mock.calls[1]?.[1]).toEqual({
      draft_id: 'r-1',
      thread_id: 'thread-existing',
      recipient_email: 'claims@example.com',
      extra_recipients: ['second@example.com'],
      cc: ['cc@example.com'],
      bcc: [],
      subject: 'Re: Claim',
      body: 'Exact body.',
      is_html: false,
      attachment: [{ name: 'proof.png', mimetype: 'image/png', s3key: 'k/1' }],
    });
    expect(result).toEqual({ draftId: 'r-1', threadId: 'thread-existing', gmailUrl: null });
  });

  it('uses an explicit thread_id over the current thread', async () => {
    mock.execute.mockImplementation(async (slug: string) =>
      slug === 'GMAIL_GET_DRAFT' ? draft(['DRAFT']) : { data: {} });
    await updateComposioGmailDraft('key', 'session', { ...input, threadId: 'thread-new' });
    expect(mock.execute.mock.calls[1]?.[1]).toMatchObject({ thread_id: 'thread-new' });
  });

  it('refuses a sent message or a missing draft before staging anything', async () => {
    mock.execute.mockResolvedValueOnce(draft(['SENT']));
    await expect(updateComposioGmailDraft('key', 'session', input)).rejects.toThrow('no longer an unsent draft');
    mock.execute.mockResolvedValueOnce({ error: 'Requested entity was not found.' });
    await expect(updateComposioGmailDraft('key', 'session', input)).rejects.toThrow('was not found');
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.execute.mock.calls.map(([slug]) => slug)).toEqual(['GMAIL_GET_DRAFT', 'GMAIL_GET_DRAFT']);
  });
});
