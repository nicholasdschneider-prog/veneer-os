import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeNodeShellProfile,
  provisionNodeShellProfile,
} from '../../installer/node-shell-profile.mjs';

describe('Node login-shell profile', () => {
  const temporaryHomes: string[] = [];

  afterEach(() => {
    for (const home of temporaryHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('adds and updates one managed PATH block without changing user content', () => {
    const initial = 'export USER_SETTING=yes\n';
    const first = mergeNodeShellProfile(initial, '/opt/node-24/bin/node');
    const second = mergeNodeShellProfile(first, '/new/node-24/bin/node');

    expect(second).toContain('export USER_SETTING=yes');
    expect(second).toContain('export PATH=\'/new/node-24/bin\':"$PATH"');
    expect(second).not.toContain('/opt/node-24/bin');
    expect(second.match(/>>> veneer-pro Node runtime >>>/g)).toHaveLength(1);
  });

  if (process.platform === 'darwin') {
    it('restores Node 24 after the macOS login profile changes PATH order', () => {
      const serviceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-node-shell-'));
      temporaryHomes.push(serviceHome);
      const nodeDir = path.join(serviceHome, 'node-24', 'bin');
      const nodeBin = path.join(nodeDir, 'node');
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(nodeBin, '#!/bin/sh\necho v24.0.0\n', { mode: 0o755 });
      provisionNodeShellProfile({ serviceHome, nodeBin });

      const version = execFileSync('/bin/zsh', ['-l', '-c', 'node --version'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: serviceHome,
          PATH: `/opt/homebrew/bin:${process.env.PATH}`,
        },
      }).trim();

      expect(version).toBe('v24.0.0');
    });
  }
});
