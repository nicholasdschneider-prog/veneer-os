import { useState } from 'react';
import { api } from '../lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VeneerMark } from '@/components/VeneerMark';

export function Setup({ email, onDone }: { email: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setup(displayName);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <VeneerMark className="size-8" />
        </div>
        <h1 className="text-2xl font-semibold">Welcome to Veneer Pro</h1>
        <p className="mt-2 text-muted-foreground">
          Your business assistant is ready. What should it call you?
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{email}</p>
        <form
          className="mt-8 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="h-12 rounded-xl bg-card px-4 text-base md:text-base"
          />
          <Button type="submit" disabled={!name.trim() || busy} className="h-12 rounded-xl text-base">
            {busy ? 'Setting up…' : 'Get started'}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </form>
      </div>
    </div>
  );
}
