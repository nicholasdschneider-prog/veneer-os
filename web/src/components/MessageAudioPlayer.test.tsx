import { afterEach, describe, expect, it, vi } from 'vitest';
import { readListenPosition } from './MessageAudioPlayer';

afterEach(() => vi.unstubAllGlobals());
describe('local message playback position', () => {
  it('resumes a valid section and offset', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"part":2,"seconds":42.5}' });
    expect(readListenPosition('message', 3)).toEqual({ part: 2, seconds: 42.5 });
  });
  it('recovers from corrupted, out-of-bounds, negative or unavailable storage', () => {
    for (const value of ['invalid', 'null', '{"part":4,"seconds":2}', '{"part":0,"seconds":-2}', '{"part":0,"seconds":"5"}']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(readListenPosition('message', 3)).toEqual({ part: 0, seconds: 0 });
    }
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Unavailable'); } });
    expect(readListenPosition('message', 3)).toEqual({ part: 0, seconds: 0 });
  });
});
