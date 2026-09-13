import Link from 'next/link';
import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { AdminPage, operatorRead } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AdminOverview({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const queues = await operatorRead(() => getOperatorQueues(actor));
  const finance = actor.roles.some(role => ['finance', 'support', 'admin'].includes(role));
  const moderation = actor.roles.some(role => ['moderator', 'admin'].includes(role));
  const sections = [
    { label: 'Open disputes', items: queues.disputes, href: '/admin/disputes', relevant: true },
    { label: 'Reconciliation cases', items: queues.cases, href: '/admin/cases', relevant: finance },
    { label: 'Provider operations', items: queues.provider_operations,
      href: '/admin/operations#provider-operations', relevant: finance },
    { label: 'Failed outbox', items: queues.failed_outbox, href: '/admin/operations#failed-outbox', relevant: finance },
    { label: 'Reconciling holds', items: queues.reconciling_holds,
      href: '/admin/operations#reconciling-holds', relevant: finance },
    { label: 'Review holds', items: queues.review_holds, href: '/admin/operations#review-holds', relevant: finance },
    { label: 'Overdue orders', items: queues.overdue_orders, href: '/admin/operations#overdue-orders', relevant: finance },
    { label: 'Pending samples', items: queues.pending_samples, href: '/admin/moderation', relevant: moderation },
    { label: 'Feature flags', items: queues.feature_flags, href: '/admin/flags', relevant: true },
  ];

  return <AdminPage actor={actor} route={route} query={query} title="Operator overview"
    description="Review queues, follow up on exceptions, and record each operational decision.">
    <p className="muted">Your roles: {actor.roles.join(', ')}. Counts show returned rows, up to 200 per queue.</p>
    <div className="admin-queue-grid">
      {sections.filter(section => section.relevant || section.items.length > 0).map(section =>
        <Link className="stat" href={section.href} key={section.label}>
          <span>{section.label} ↗</span>
          <strong>{section.items.length}</strong>
        </Link>)}
    </div>
  </AdminPage>;
}
