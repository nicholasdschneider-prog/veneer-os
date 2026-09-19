import { ChevronRight, FolderOpen, SquareTerminal } from 'lucide-react';

const TOOLS = [
  {
    title: 'File browser',
    description: 'Browse and manage files on this Veneer host.',
    hash: '#/browse',
    icon: FolderOpen,
  },
  {
    title: 'Terminal',
    description: 'Open a command-line session on this Veneer host.',
    hash: '#/terminal',
    icon: SquareTerminal,
  },
];

export function Tools({ onNavigate }: { onNavigate: (hash: string) => void }) {
  return (
    <div className="h-full overflow-y-auto px-4 py-7 sm:px-6 md:px-8">
      <main className="mx-auto w-full max-w-3xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Direct access to host-level utilities. Configuration stays in Settings.
          </p>
        </header>
        <div className="overflow-hidden rounded-2xl border bg-card">
          {TOOLS.map((tool, index) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.hash}
                type="button"
                onPointerUp={() => onNavigate(tool.hash)}
                className={`flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/50 ${
                  index > 0 ? 'border-t' : ''
                }`}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{tool.title}</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{tool.description}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
}
