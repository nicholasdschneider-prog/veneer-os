import React from 'react';
import { createRoot } from 'react-dom/client';
import { CallButton, CallIcon } from '../../web/src/components/CallButton';
import { VoiceCallPanel } from '../../web/src/components/VoiceCallPanel';
import '../../web/src/styles.css';
// Synthetic component fixture: no providers, microphone requests, or API traffic.
const hit = () => document.body.dataset.calls = String(Number(document.body.dataset.calls || 0) + 1);
createRoot(document.getElementById('root')!).render(<main className="space-y-5 bg-background p-4 text-foreground">
  <h1>Live call controls</h1>
  <div className="flex flex-wrap items-center gap-3"><CallButton aria-label="Talk with fixture bot" onClick={hit} /><CallButton onClick={hit}>Call fixture bot</CallButton><CallButton onClick={hit}>Resume conversation</CallButton></div>
  <div className="flex flex-wrap gap-3"><CallButton disabled aria-label="Unavailable call" /><CallButton disabled aria-busy="true">Connecting…</CallButton></div>
  <button onClick={hit} className="flex min-h-[44px] items-center gap-2"><span className="rounded-full bg-blue-600 p-1 text-white"><CallIcon /></span>Talk with this bot</button>
  <VoiceCallPanel name="Fixture bot" botId="fixture" callerName="Example User" status="Ready when you are" active={false} connected={false} muted={false} level={0} history={[]} ready onStart={hit} onMute={()=>{}} onEnd={()=>{}} onStandby={()=>{}} />
</main>);
