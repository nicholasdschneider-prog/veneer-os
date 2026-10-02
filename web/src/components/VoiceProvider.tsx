import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from 'react';
const LiveVoice = lazy(() => import('../screens/LiveVoice').then(module => ({ default: module.LiveVoice })));
import { micDictation } from '../lib/stt';

const VoiceContext = createContext<{ pinnedId: string | null; hotline: () => void; open: (id: string, decisionId?: string, options?: { incoming?: boolean }) => void }>({ pinnedId: null, hotline: () => {}, open: () => {} });
export const useLiveVoice = () => useContext(VoiceContext);

/** Above routing: navigation never silently switches or unmounts the call. */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [decisionId, setDecisionId] = useState<string | undefined>();
  // A call the bot placed: it connects as soon as it opens and closes itself when the bot hangs up.
  const [incoming, setIncoming] = useState(false);
  return <VoiceContext.Provider value={{ pinnedId, hotline: () => { if (!pinnedId && !micDictation.isActive && !micDictation.isFinalizing) { setDecisionId(undefined); setIncoming(false); setPinnedId('question-hotline'); } }, open: (id, focus, options) => {
    if (micDictation.isActive || micDictation.isFinalizing) return;
    if (!pinnedId) { window.dispatchEvent(new Event('veneer-live-voice-opening')); setDecisionId(focus); setIncoming(!!options?.incoming && !!focus); setPinnedId(id); }
  } }}>
    {children}
    {pinnedId && <div className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+4rem)] z-50 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2">
      <Suspense fallback={<p role="status" className="rounded-xl border bg-background p-4">Opening voice…</p>}><LiveVoice key={pinnedId} compact hotline={pinnedId === 'question-hotline'} botConversationId={pinnedId === 'question-hotline' ? undefined : pinnedId} decisionId={decisionId} incoming={incoming && pinnedId !== 'question-hotline'} onBack={() => setPinnedId(null)} /></Suspense>
    </div>}
  </VoiceContext.Provider>;
}
