import { Chat } from '../src/screens/Chat';
import { BotConversationRail } from '../src/components/BotConversationRail';
import { SplitView } from '../src/components/layout/SplitView';
import { FloatingDesktopProvider } from '../src/components/desktop/FloatingDesktop';
// Isolated browser fixture: production components, real fixture API, no provider credentials.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bots } from '../src/screens/Bots';
import { NavShell } from '../src/components/NavBar';
import { applyColorMode, applyTheme } from '../src/lib/theme';
import '@fontsource-variable/inter';
import '../src/styles.css';
applyTheme('default');
applyColorMode('dark');
function Fixture() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const change = () => setHash(location.hash);
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);
  return (
    <NavShell
      current="bots"
      canManage
      signedInEmail="fixture@example.test"
      onNavigate={(h) => {
        location.hash = h;
      }}
    >
      {hash.startsWith('#/chat/') ? <SplitView storageKey="fixture:bots" mobileShows="detail" sidebar={<BotConversationRail selectedId={hash.split('/')[2].split('?')[0]} onNavigate={h => { location.hash = h; }} />}><Chat conversationId={hash.split('/')[2].split('?')[0]} backHash="#/bots" artifacts={[]} onOpenArtifact={() => {}} onRefreshArtifacts={async () => []} onPublishArtifact={async () => {}} onOpenCitations={() => {}} onOpenProjectFile={() => {}} onNavigate={h => { location.hash = h; }} onToast={() => {}} /></SplitView> : <Bots
        decisionId={hash.split('?')[0].split('/')[2]}
        registrationRequested={hash.includes('register=1')}
        onNavigate={(h) => {
          location.hash = h;
        }}
      />}
    </NavShell>
  );
}
createRoot(document.getElementById('root')!).render(<FloatingDesktopProvider><Fixture /></FloatingDesktopProvider>);
