import { Button } from '@/components/ui/button';
import { VeneerMark } from '@/components/VeneerMark';

/**
 * Shown when someone is signed in but an admin hasn't approved their account
 * yet (GET /api/me → pending). Mirrors the Setup screen's full-screen layout.
 * "Check again" just re-fetches /api/me — once approved, App renders the app.
 */
export function PendingApproval({ email, onRecheck }: { email: string; onRecheck: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <VeneerMark className="size-8" />
        </div>
        <h1 className="text-2xl font-semibold">Waiting for approval</h1>
        <p className="mt-2 text-muted-foreground">You're signed in as {email}.</p>
        <p className="mt-2 text-muted-foreground">
          An administrator needs to approve your account before you can use Veneer Pro. You'll be let in as soon as
          they do.
        </p>
        <Button onPointerUp={onRecheck} className="mt-8 h-12 w-full rounded-xl text-base">
          Check again
        </Button>
      </div>
    </div>
  );
}
