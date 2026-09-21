import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeWorkspace } from '../src/screens/EmployeeWorkspace';
import { Bots } from '../src/screens/Bots';
import { UsersPage } from '../src/screens/settings/UsersPage';
import { FloatingDesktopProvider } from '../src/components/desktop/FloatingDesktop';
import { applyColorMode, applyTheme } from '../src/lib/theme';
import '@fontsource-variable/inter';
import '../src/styles.css';
applyTheme('default'); applyColorMode('light');
function Fixture() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const change = () => setHash(location.hash); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  const onNavigate = (h: string) => { location.hash = h; };
  if (location.search.includes('owner')) return hash.includes('people') ? <div className="p-6"><UsersPage /></div> : <Bots decisionId={hash.split('/')[2]} onNavigate={onNavigate} />;
  return <EmployeeWorkspace hash={hash} email="ali@fixture.test" onNavigate={onNavigate} />;
}
createRoot(document.getElementById('root')!).render(<FloatingDesktopProvider><Fixture /></FloatingDesktopProvider>);
