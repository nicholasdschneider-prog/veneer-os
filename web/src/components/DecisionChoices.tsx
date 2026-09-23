import { Button } from './ui/button';
import { defaultDecisionChoices, type BotProposal } from '@/lib/bots';

/** A click submits one explicit action against the caller's reviewed proposal version. */
export function DecisionChoices({ choices, disabled, onChoose }: {
  choices?: BotProposal['choices']; disabled: boolean; onChoose: (id: string) => void;
}) {
  return <div className="mt-4 flex flex-col gap-2">
    {(choices ?? defaultDecisionChoices).map((choice, index) => <Button key={choice.id} type="button" className="h-auto min-h-12 justify-start whitespace-normal py-3" variant="outline" disabled={disabled} onClick={() => onChoose(choice.id)}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border text-xs text-muted-foreground">{String.fromCharCode(65 + index)}</span>
      <span className="min-w-0 text-left"><span className="block">{choice.label}</span>{choice.description && <span className="block text-xs font-normal text-muted-foreground">{choice.description}</span>}<span className="block text-xs font-normal text-muted-foreground">{choice.action === 'approve' ? 'Approves this proposal' : choice.action === 'reject' ? 'Declines this proposal' : choice.action === 'defer' ? 'Defers this decision' : 'Withdraws this request'}</span></span>
    </Button>)}
  </div>;
}
