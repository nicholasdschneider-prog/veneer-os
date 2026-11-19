import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const file = new File(['x'], 'label.jpg', { type: 'image/jpeg' });
const ok = () => new Response(JSON.stringify({ ok: true, file: { path: '/p/label.jpg', name: 'label.jpg', size: 1 } }), { status: 200 });

describe('uploadFile', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('retries a dropped connection and returns the stored file', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const result = api.uploadFile(file);
    await vi.runAllTimersAsync();
    expect((await result).path).toBe('/p/label.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after three dropped attempts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetchMock);
    const result = api.uploadFile(file).catch((error: Error) => error.message);
    await vi.runAllTimersAsync();
    expect(await result).toBe('Load failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request the server refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Empty upload' }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.uploadFile(file)).rejects.toThrow('Empty upload');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
