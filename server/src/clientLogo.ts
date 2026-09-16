import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLIENT_LOGO_MAX_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function clientLogoPath(dataDir: string): string {
  return path.join(dataDir, 'branding', 'client-logo.png');
}

export function isPng(data: Buffer): boolean {
  return data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** Write beside the current logo, then rename so readers never see a partial file. */
export function writeClientLogo(dataDir: string, data: Buffer): string {
  const target = clientLogoPath(dataDir);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.client-logo-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

export function removeClientLogo(dataDir: string): void {
  fs.rmSync(clientLogoPath(dataDir), { force: true });
}
