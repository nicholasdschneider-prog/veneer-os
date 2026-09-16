interface ClipboardFileItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

interface ClipboardFileData {
  items: ArrayLike<ClipboardFileItem>;
  files: ArrayLike<File>;
}

const GENERIC_IMAGE_NAME = /^(?:image|clipboard|pasted-image)(?:\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif))?$/i;

function extensionForImage(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/svg+xml':
      return 'svg';
    case 'image/tiff':
      return 'tiff';
    default: {
      const subtype = type.slice('image/'.length).toLowerCase();
      return /^[a-z0-9]+$/.test(subtype) ? subtype : 'png';
    }
  }
}

function clipboardImageName(file: File, capturedAt: Date, index: number): string {
  const current = file.name.trim();
  if (current && !GENERIC_IMAGE_NAME.test(current)) return current;

  const timestamp = capturedAt.toISOString().replaceAll(':', '-').replace('.', '-');
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `pasted-image-${timestamp}${suffix}.${extensionForImage(file.type)}`;
}

function withClipboardImageName(file: File, capturedAt: Date, index: number): File {
  const name = clipboardImageName(file, capturedAt, index);
  if (name === file.name) return file;

  try {
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  } catch {
    // Older WebKit can expose clipboard Files without supporting File construction.
    return file;
  }
}

function withClipboardImageType(file: File, type: string): File {
  if (file.type === type) return file;

  try {
    return new File([file], file.name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** Return only pasted images. Text and non-image clipboard files remain untouched. */
export function clipboardImageFiles(data: ClipboardFileData, capturedAt = new Date()): File[] {
  const images: File[] = [];

  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    const type = file?.type.startsWith('image/') ? file.type : item.type;
    if (!file || !type.startsWith('image/')) continue;
    images.push(withClipboardImageType(file, type));
  }

  // Some WebKit versions populate files but not items for image paste.
  const source = images.length > 0 ? images : Array.from(data.files).filter((file) => file.type.startsWith('image/'));
  return source.map((file, index) => withClipboardImageName(file, capturedAt, index));
}

interface ComposerPasteEvent {
  clipboardData: ClipboardFileData;
  preventDefault(): void;
}

/** Handle image paste only, allowing the browser to process every ordinary paste. */
export function handleComposerImagePaste(
  event: ComposerPasteEvent,
  addFiles: (files: readonly File[]) => void,
): boolean {
  const images = clipboardImageFiles(event.clipboardData);
  if (images.length === 0) return false;

  event.preventDefault();
  addFiles(images);
  return true;
}
