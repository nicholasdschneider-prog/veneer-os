import { defineConfig } from 'vitest/config';

/**
 * The suite is ~180 files and many of them spawn real child processes (fake
 * provider CLIs, `node --import tsx` MCP servers, migrating services). Vitest
 * runs those files in parallel forks, and under that pressure a bare
 * `node -e ''` on this machine goes from ~40ms to 300ms-1s. Vitest's stock
 * 5s test timeout leaves no room for a test that spawns several children in
 * sequence, so tests that pass alone time out in the full run.
 *
 * The timeouts below are a ceiling for pathological cases, not a budget any
 * healthy test is meant to use: the individual tests still wait on real
 * signals (poll for the event/request they expect) rather than on fixed
 * sleeps, so a genuine hang still fails, just later.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
