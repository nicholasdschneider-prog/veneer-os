export const CLIENT_LOGO_SIZE = 512;
export const CLIENT_LOGO_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const CLIENT_LOGO_CHANGED_EVENT = 'veneer:client-logo-changed';

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const SUPPORTED_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));

export interface SquareImageFit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fit the whole source inside the square without cropping or distortion. */
export function fitImageInSquare(sourceWidth: number, sourceHeight: number, size = CLIENT_LOGO_SIZE): SquareImageFit {
  if (![sourceWidth, sourceHeight, size].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Logo dimensions are invalid.');
  }
  const scale = Math.min(size / sourceWidth, size / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (size - width) / 2,
    y: (size - height) / 2,
    width,
    height,
  };
}

function fileMimeType(file: File): string | null {
  const declared = file.type.toLowerCase();
  if (SUPPORTED_MIME_TYPES.has(declared)) return declared;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? null;
}

async function safeImageBlob(file: File, mimeType: string): Promise<Blob> {
  if (mimeType !== 'image/svg+xml') return file;

  const source = await file.text();
  if (
    /<!doctype|<!entity|<\s*(?:script|foreignObject|iframe|object|embed)\b/i.test(source) ||
    /@import\b/i.test(source) ||
    /url\(\s*["']?\s*(?!#|data:image\/)/i.test(source)
  ) {
    throw new Error('That SVG contains unsupported active content.');
  }

  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror')) throw new Error('That SVG could not be read.');
  for (const element of document.querySelectorAll('*')) {
    const reference =
      element.getAttribute('href') ??
      element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (reference && !reference.startsWith('#') && !reference.startsWith('data:image/')) {
      throw new Error('That SVG references an external image.');
    }
  }
  return new Blob([source], { type: 'image/svg+xml' });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const imageUrl = URL.createObjectURL(blob);
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error('That image could not be read.'));
    };
    image.src = imageUrl;
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The square logo could not be created.'));
    }, 'image/png');
  });
}

/**
 * Rasterize every accepted source to one transparent 512×512 PNG. SVG source
 * is screened for active/external content first and is never sent to the API.
 */
export async function normalizeClientLogo(file: File): Promise<Blob> {
  if (file.size === 0) throw new Error('Choose a non-empty image.');
  if (file.size > CLIENT_LOGO_SOURCE_MAX_BYTES) throw new Error('Choose an image smaller than 10 MB.');
  const mimeType = fileMimeType(file);
  if (!mimeType) throw new Error('Choose a PNG, JPG, WebP, or SVG image.');

  const safeBlob = await safeImageBlob(file, mimeType);
  const image = await loadImage(safeBlob);
  const imageUrl = image.src;
  try {
    const fit = fitImageInSquare(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = CLIENT_LOGO_SIZE;
    canvas.height = CLIENT_LOGO_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare the logo.');
    context.clearRect(0, 0, CLIENT_LOGO_SIZE, CLIENT_LOGO_SIZE);
    context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
    return await canvasPng(canvas);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
