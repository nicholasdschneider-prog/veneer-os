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
      <Bots
        decisionId={hash.split('/')[2]}
        onNavigate={(h) => {
          location.hash = h;
        }}
      />
    </NavShell>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
