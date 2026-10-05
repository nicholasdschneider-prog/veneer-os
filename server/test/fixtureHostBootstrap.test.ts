import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('harmless native fixture host acceptance package', () => {
  it('boots real C/Node probes and validates denial controls plus fail-closed cases', () => {
    const script = fileURLToPath(new URL('../../scripts/fixture-host/bootstrap_test.py', import.meta.url));
    const output = execFileSync('/usr/bin/python3', [script, '-v'], {
      encoding: 'utf8', timeout: 30_000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toBe('');
  }, 35_000);
});
