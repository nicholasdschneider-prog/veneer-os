import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { TeachingRecorder, type RecordedNarration } from './teachingRecorder';
let stopped: ReturnType<typeof vi.fn>, track: {
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
};
class Recorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: {
        data: Blob;
    }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fake-audio']) }); this.onstop?.(); }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); stopped = vi.fn(); track = { stop: stopped, onended: null }; vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) } }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('requests only microphone audio, releases it, timestamps and saves once', async () => {
    const clip = vi.fn(async (_clip: RecordedNarration) => { }), end = vi.fn();
    const r = new TeachingRecorder(99000, clip, end);
    await r.start();
    await vi.advanceTimersByTimeAsync(1000);
    await r.stop();
    await r.stop();
    expect(clip).toHaveBeenCalledTimes(1);
    expect(clip.mock.calls[0]?.[0]).toMatchObject({ offset: 1000, duration: 1000 });
    expect(stopped).toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
});
it('stops at the session wall-clock limit without recording paused time', async () => { const clip = vi.fn(async (_clip: RecordedNarration) => { }); const r = new TeachingRecorder(100000 - 599000, clip, () => { }); await r.start(); await vi.advanceTimersByTimeAsync(2000); expect(clip).toHaveBeenCalledTimes(1); expect(clip.mock.calls[0]?.[0]).toMatchObject({ offset: 599000, duration: 1000 }); expect(stopped).toHaveBeenCalled(); });
it('releases late microphone permission after unmount without starting recording', async () => { let resolve!: (s: unknown) => void; (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(r => { resolve = r; })); const clip = vi.fn(async (_clip: RecordedNarration) => { }); const r = new TeachingRecorder(100000, clip, () => { }); const starting = r.start(); await r.stop(); resolve({ getTracks: () => [track], getAudioTracks: () => [track] }); await starting; expect(stopped).toHaveBeenCalledOnce(); expect(clip).not.toHaveBeenCalled(); });
it('surfaces denied permission and handles microphone disconnection', async () => { (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Error('Permission denied')); const clip = vi.fn(async (_clip: RecordedNarration) => { }); await expect(new TeachingRecorder(100000, clip, () => { }).start()).rejects.toThrow('Permission denied'); const r = new TeachingRecorder(100000, clip, () => { }); await r.start(); track.onended?.(); await r.stop(); expect(clip).toHaveBeenCalledOnce(); });
