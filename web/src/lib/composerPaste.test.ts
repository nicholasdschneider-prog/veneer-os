import { describe, expect, it } from 'vitest';
import { clipboardImageFiles, handleComposerImagePaste } from './composerPaste';

function clipboardItem(file: File | null, type = file?.type ?? '', kind = 'file') {
  return { kind, type, getAsFile: () => file };
}

const capturedAt = new Date('2026-08-24T18:30:45.000Z');

describe('chat composer image paste', () => {
  it('extracts image items and gives generic clipboard names a useful unique name', () => {
    const first = new File(['one'], 'image.png', { type: 'image/png' });
    const second = new File(['two'], '', { type: 'image/jpeg' });

    const result = clipboardImageFiles(
      { items: [clipboardItem(first), clipboardItem(second)], files: [first, second] },
      capturedAt,
    );

    expect(result.map((file) => file.name)).toEqual([
      'pasted-image-2026-08-24T18-30-45-000Z.png',
      'pasted-image-2026-08-24T18-30-45-000Z-2.jpg',
    ]);
    expect(result.map((file) => file.type)).toEqual(['image/png', 'image/jpeg']);
  });

  it('leaves text-only paste alone', () => {
    const result = clipboardImageFiles(
      { items: [clipboardItem(null, 'text/plain', 'string')], files: [] },
      capturedAt,
    );

    expect(result).toEqual([]);
  });

  it('takes only images from mixed clipboard content and preserves meaningful names', () => {
    const image = new File(['image'], 'design-reference.webp', { type: 'image/webp' });
    const document = new File(['document'], 'notes.pdf', { type: 'application/pdf' });

    const result = clipboardImageFiles(
      {
        items: [
          clipboardItem(null, 'text/plain', 'string'),
          clipboardItem(document),
          clipboardItem(image),
        ],
        files: [document, image],
      },
      capturedAt,
    );

    expect(result).toEqual([image]);
  });

  it('falls back to clipboard files for WebKit clipboard events with empty items', () => {
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    const result = clipboardImageFiles({ items: [], files: [image] }, capturedAt);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('pasted-image-2026-08-24T18-30-45-000Z.png');
  });

  it('uses the clipboard item image type when WebKit omits the File type', () => {
    const image = new File(['image'], 'image.png');
    const result = clipboardImageFiles(
      { items: [clipboardItem(image, 'image/png')], files: [image] },
      capturedAt,
    );

    expect(result[0]?.type).toBe('image/png');
    expect(result[0]?.name).toBe('pasted-image-2026-08-24T18-30-45-000Z.png');
  });

  it('prevents the browser paste and attaches files only when an image is present', () => {
    const image = new File(['image'], 'reference.png', { type: 'image/png' });
    let prevented = false;
    let added: readonly File[] = [];

    const handled = handleComposerImagePaste(
      {
        clipboardData: { items: [clipboardItem(image)], files: [image] },
        preventDefault: () => {
          prevented = true;
        },
      },
      (files) => {
        added = files;
      },
    );

    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(added).toEqual([image]);
  });

  it('does not suppress or attach an ordinary text paste', () => {
    let prevented = false;
    let added = false;

    const handled = handleComposerImagePaste(
      {
        clipboardData: { items: [clipboardItem(null, 'text/plain', 'string')], files: [] },
        preventDefault: () => {
          prevented = true;
        },
      },
      () => {
        added = true;
      },
    );

    expect(handled).toBe(false);
    expect(prevented).toBe(false);
    expect(added).toBe(false);
  });
});
