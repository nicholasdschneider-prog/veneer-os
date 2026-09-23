export interface RecordedNarration {
    key: string;
    blob: Blob;
    offset: number;
    duration: number;
}
/** One clip per uninterrupted microphone interval; no tab/system audio is requested. */
export class TeachingRecorder {
    private stream: MediaStream | null = null;
    private recorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private started = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;
    private done: Promise<void> | null = null;
    private resolveDone: (() => void) | null = null;
    constructor(private sessionStart: number, private onClip: (clip: RecordedNarration) => Promise<void>, private onEnd: () => void) { }
    async start() {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
            throw Error('This browser cannot record microphone audio. Use a supported browser or continue without narration.');
        const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
        if (!mime)
            throw Error('This browser has no supported audio recorder. Continue without narration.');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (this.stopped) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }
        this.stream = stream;
        try {
            this.recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
            this.started = Date.now();
            if (this.started >= this.sessionStart + 600000)
                throw Error('The demonstration time limit was reached.');
            this.done = new Promise(resolve => { this.resolveDone = resolve; });
            this.recorder.ondataavailable = e => { if (e.data.size)
                this.chunks.push(e.data); };
            this.recorder.onstop = () => {
                const duration = Math.max(1, Math.min(Date.now() - this.started, 600000 - (this.started - this.sessionStart)));
                const blob = new Blob(this.chunks, { type: this.recorder!.mimeType });
                this.release();
                this.onEnd();
                void (blob.size ? this.onClip({ key: crypto.randomUUID(), blob, offset: Math.max(0, this.started - this.sessionStart), duration }) : Promise.resolve()).finally(() => this.resolveDone?.());
            };
            this.recorder.onerror = () => { void this.stop(); };
            stream.getAudioTracks().forEach(track => { track.onended = () => { void this.stop(); }; });
            this.recorder.start(1000);
            this.timer = setTimeout(() => { void this.stop(); }, this.sessionStart + 600000 - Date.now());
        }
        catch (e) {
            this.release();
            this.resolveDone?.();
            throw e;
        }
    }
    private release() { clearTimeout(this.timer); this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); this.stream = null; }
    async stop() {
        this.stopped = true;
        if (this.recorder && this.recorder.state !== 'inactive')
            this.recorder.stop();
        else
            this.release();
        await this.done;
    }
}
