import type { BotDecision } from '@/lib/bots';

export function BotOrderLink({ order }: { order: BotDecision['order_reference'] }) {
  if (!order) return null;
  const label = `Order ${order.number.startsWith('#') ? order.number : '#' + order.number}`;
  return <div className="my-3 flex flex-wrap items-center gap-2 text-sm">
    <span className="font-semibold">{label}</span>
    {order.url && <a href={order.url} target="_blank" rel="noopener noreferrer" className="rounded-md border px-2 py-1 font-medium underline underline-offset-2" onClick={e => e.stopPropagation()}>
      {order.direct ? 'Open in Shopify ↗' : 'Find in Shopify ↗'}
    </a>}
  </div>;
}
