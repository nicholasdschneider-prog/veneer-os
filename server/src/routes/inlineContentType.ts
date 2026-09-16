import path from 'node:path';

/**
 * Content types that the web UI can safely render inline. Express' sendFile
 * usually infers these itself, but setting them explicitly keeps CSV, text and
 * HTML previews consistent across environments.
 */
export function inlineContentType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.txt':
    case '.md':
    case '.markdown':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.otf':
      return 'font/otf';
    case '.ttf':
      return 'font/ttf';
    default:
      return null;
  }
}

/**
 * CSP for inline responses that can execute script (HTML documents, SVG).
 * Agent-written files must not run with the app's origin — a prompt-injected
 * agent could otherwise exfiltrate via authenticated /api calls when the user
 * opens the inline URL directly in a tab. `sandbox` forces an opaque origin,
 * matching the sandboxed iframe the artifact panel uses.
 */
export function inlineContentSecurityPolicy(contentType: string | null): string | null {
  if (!contentType) return null;
  if (contentType.startsWith('text/html') || contentType.startsWith('image/svg')) {
    return 'sandbox allow-scripts allow-popups';
  }
  return null;
}
