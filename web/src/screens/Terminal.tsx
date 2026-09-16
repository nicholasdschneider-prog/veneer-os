import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ClipboardPaste,
  Pin,
  PinOff,
  RotateCcw,
} from 'lucide-react';
// Rename-import: this screen is also called Terminal in spirit, and the app
// already has a 'terminal' theme — keep the wterm component unmistakable.
import { Terminal as WtermTerminal, type TerminalHandle } from '@wterm/react';
import '@wterm/react/css';
import { api } from '../lib/api';
import { TermSocket, type TermStatus } from '../lib/termSocket';
import { prepareTerminalPaste } from '../lib/terminalPaste';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// wterm has no clear()/reset() API — this ANSI triple (clear screen, clear
// scrollback, home cursor) is the documented fallback so a reconnect's replay
// buffer doesn't stack on top of what's already on screen.
const CLEAR_SEQ = '\x1b[2J\x1b[3J\x1b[H';

const KEY_BTN =
  'h-9 min-w-9 shrink-0 rounded-lg border-border/60 px-2.5 font-mono text-xs text-muted-foreground';

export function TerminalScreen({
  projectId,
  onBack,
  pinned,
  onPinnedChange,
  onToast,
}: {
  projectId: string | null;
  onBack: () => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => Promise<void>;
  onToast: (message: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalHandle>(null);
  const socketRef = useRef<TermSocket | null>(null);
  const dimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const ctrlArmedRef = useRef(false);

  const [projectName, setProjectName] = useState<string | null>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [wtReady, setWtReady] = useState(false);
  const [exited, setExited] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Bumped by the "Reconnect" button to tear down a fatally-errored socket
  // (e.g. after a takeover) and build a fresh one.
  const [socketEpoch, setSocketEpoch] = useState(0);
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const [pasteBlocked, setPasteBlocked] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);

  const setCtrlArmed = useCallback((armed: boolean) => {
    ctrlArmedRef.current = armed;
    setCtrlArmedState(armed);
  }, []);

  // Sticky-Ctrl transform: when armed, the next single printable character
  // becomes its control code (e.g. c -> \x03), then Ctrl disarms.
  const sendData = useCallback(
    (data: string) => {
      let out = data;
      if (ctrlArmedRef.current && data.length === 1) {
        const code = data.charCodeAt(0);
        if (code >= 0x20 && code < 0x7f) {
          out = String.fromCharCode(code & 0x1f);
          setCtrlArmed(false);
        }
      }
      socketRef.current?.sendInput(out);
    },
    [setCtrlArmed],
  );

  const sendKey = useCallback(
    (seq: string) => {
      sendData(seq);
      termRef.current?.focus();
    },
    [sendData],
  );

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setPasteBlocked(false);
      if (!text) return;

      const bracketedPaste = termRef.current?.instance?.bridge?.bracketedPaste() ?? false;
      setCtrlArmed(false);
      socketRef.current?.sendInput(prepareTerminalPaste(text, bracketedPaste));
    } catch {
      setPasteBlocked(true);
    } finally {
      termRef.current?.focus();
    }
  }, [setCtrlArmed]);

  // Reset when the terminal is stuck. If the socket is live, restart the shell
  // (kills a hung/runaway process and spawns a fresh login shell — the server
  // replays a cleared screen). If the connection itself is wedged or closed,
  // tear the socket down and rebuild it via a socketEpoch bump instead.
  const resetTerminal = useCallback(() => {
    if (status === 'open') {
      socketRef.current?.sendRestart();
    } else {
      setFatalError(null);
      setExited(false);
      setSocketEpoch((n) => n + 1);
    }
    termRef.current?.focus();
  }, [status]);

  // Project name for the header title.
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    void api
      .project(projectId)
      .then((r) => {
        if (!stop) setProjectName(r.project.name);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [projectId]);

  // One socket per mount (and per Reconnect). Gated on wtReady so the replay
  // from the server's "ready" frame never races the async WASM init.
  useEffect(() => {
    if (!wtReady) return;
    const dims = dimsRef.current ?? { cols: 80, rows: 24 };
    const sock = new TermSocket(
      projectId ? { scope: 'project', projectId } : { scope: 'universal' },
      dims.cols,
      dims.rows,
    );
    sock.onStatus = setStatus;
    sock.onOutput = (data) => termRef.current?.write(data);
    sock.onReady = (replay, cols, rows) => {
      setExited(false);
      const t = termRef.current;
      t?.write(CLEAR_SEQ);
      if (replay) t?.write(replay);
      // The server sized the pty from our connect query; if the terminal has
      // since reflowed (rotation, keyboard), sync it.
      const d = dimsRef.current;
      if (d && (d.cols !== cols || d.rows !== rows)) sock.sendResize(d.cols, d.rows);
      t?.focus();
    };
    sock.onExit = () => setExited(true);
    sock.onErrorMsg = (message) => setFatalError(message);
    sock.connect();
    socketRef.current = sock;
    return () => {
      socketRef.current = null;
      sock.dispose();
    };
  }, [projectId, wtReady, socketEpoch]);

  // iOS soft keyboard: size the screen to the visual viewport so the prompt
  // and key bar stay visible; wterm's autoResize then reflows the grid. Capped
  // at 100% (the h-full default) — the bottom nav sits below this screen, so
  // the raw viewport height would overflow and put the key bar on top of it.
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const el = rootRef.current;
      if (!el) return;
      el.style.height = vv ? `min(${vv.height}px, 100%)` : '100%';
    };
    apply();
    vv?.addEventListener('resize', apply);
    return () => vv?.removeEventListener('resize', apply);
  }, []);

  const statusDot =
    status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-red-500';

  return (
    <div ref={rootRef} className="mx-auto flex h-full w-full max-w-5xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon-lg" className="rounded-full" onPointerUp={onBack} aria-label="Back">
          <ChevronLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{projectId ? (projectName ?? 'Project') : 'Terminal'}</p>
          <p className="truncate text-xs text-muted-foreground">{projectId ? 'Project terminal' : 'Home'}</p>
        </div>
        {/* Pin: adds a Terminal icon to the left rail (bottom bar on mobile).
            The rail entry always opens the home terminal, so the label stays
            generic even while a project terminal is on screen. */}
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn('rounded-full', pinned && 'text-primary')}
          onPointerUp={() => {
            if (pinSaving) return;
            setPinSaving(true);
            void onPinnedChange(!pinned)
              .catch((error) => onToast(error instanceof Error ? error.message : 'Could not update the sidebar.'))
              .finally(() => setPinSaving(false));
          }}
          disabled={pinSaving}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin Terminal from the sidebar' : 'Pin Terminal to the sidebar'}
          title={pinned ? 'Unpin Terminal from the sidebar' : 'Pin Terminal to the sidebar'}
        >
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className="rounded-full"
          onPointerUp={resetTerminal}
          aria-label="Reset terminal"
          title="Reset terminal (restart the shell)"
        >
          <RotateCcw className="size-4" />
        </Button>
        <span
          className={cn('mr-2 size-2.5 shrink-0 rounded-full', statusDot)}
          role="status"
          aria-label={`Connection ${status}`}
        />
      </header>

      {/* Terminal — always dark regardless of app theme (wterm's default
          stylesheet is VS Code Dark+-ish; the wrapper matches its #1e1e1e). */}
      <div className="relative min-h-0 flex-1 bg-[#1e1e1e]">
        <WtermTerminal
          ref={termRef}
          className="h-full w-full"
          autoResize
          cursorBlink
          onData={sendData}
          onResize={(cols, rows) => {
            dimsRef.current = { cols, rows };
            socketRef.current?.sendResize(cols, rows);
          }}
          onReady={(wt) => {
            setWtReady(true);
            wt.focus();
          }}
          onError={() => setFatalError('Terminal failed to initialize')}
        />
        {exited && !fatalError ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 text-center">
            <p className="font-medium text-white">Shell exited</p>
            <Button
              className="h-11 rounded-xl px-5"
              onPointerUp={() => socketRef.current?.sendRestart()}
            >
              Restart shell
            </Button>
          </div>
        ) : null}
        {fatalError ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center">
            <p className="font-medium text-white">{fatalError}</p>
            <Button
              className="h-11 rounded-xl px-5"
              onPointerUp={() => {
                setFatalError(null);
                setExited(false);
                setSocketEpoch((n) => n + 1);
              }}
            >
              Reconnect
            </Button>
          </div>
        ) : null}
      </div>

      {/* Mobile key bar. preventDefault on pointerdown keeps focus on wterm's
          hidden textarea so the iOS keyboard stays up while tapping keys. */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-t px-3 pb-2 pt-2">
        <Button
          variant="outline"
          className={cn(KEY_BTN, 'gap-1.5 font-sans', pasteBlocked && 'border-destructive text-destructive')}
          aria-label={pasteBlocked ? 'Clipboard access was blocked. Try paste again' : 'Paste from clipboard'}
          aria-live="polite"
          title={pasteBlocked ? 'Clipboard access was blocked. Allow access, then try again.' : 'Paste from clipboard'}
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => void pasteClipboard()}
        >
          <ClipboardPaste className="size-3.5" />
          {pasteBlocked ? 'Paste blocked' : 'Paste'}
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x1b')}
        >
          Esc
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\t')}
        >
          Tab
        </Button>
        <Button
          variant="outline"
          className={cn(KEY_BTN, ctrlArmed && 'border-primary bg-primary text-primary-foreground')}
          aria-pressed={ctrlArmed}
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => {
            setCtrlArmed(!ctrlArmedRef.current);
            termRef.current?.focus();
          }}
        >
          Ctrl
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          aria-label="Arrow up"
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x1b[A')}
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          aria-label="Arrow down"
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x1b[B')}
        >
          <ArrowDown className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          aria-label="Arrow left"
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x1b[D')}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          aria-label="Arrow right"
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x1b[C')}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          className={KEY_BTN}
          aria-label="Control-C"
          onPointerDown={(e) => e.preventDefault()}
          onPointerUp={() => sendKey('\x03')}
        >
          ^C
        </Button>
      </div>
    </div>
  );
}
