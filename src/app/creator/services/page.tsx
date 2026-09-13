import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function CreatorServicesPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/creator/services";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  return <main className="container">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Creator workspace"
        title="My services"
        description="Publish only services with complete scope, samples, and available capacity."
      />
      <Link className="button button-dark" href="/creator/services/new">New service ↗</Link>
    </div>
    {rows(d.services).length ? <div className="cards">
      {rows(d.services).map(s => <div className="panel" key={str(s.id)}>
        <div className="inline-actions">
          <Badge>
            {str(s.status)}
          </Badge>
          <span className="muted">
            {num(s.available_units)}
            {" / "}
            {num(s.total_units)}
            {" slots"}
          </span>
        </div>
        <h3>
          {str(s.title)}
        </h3>
        <p>
          {str(s.description)}
        </p>
        <div className="service-bottom">
          <strong>
            {money(s.price_minor)}
          </strong>
          <span>
            {num(s.turnaround_hours)}
            {" hours · "}
            {str(s.taxonomy)}
          </span>
        </div>
        <div className="inline-actions">
          <Link className="text-link" href={`/services/${str(s.id)}`}>Open public page ↗</Link>
          {str(s.status) === 'DRAFT' && <CommandForm
            command="publish_service"
            label="Publish"
            values={{
              service_id: str(s.id)
            }}
            returnTo={route}
          />}
          {" "}
          {str(s.status) === 'PUBLISHED' && <CommandForm
            command="pause_service"
            label="Pause"
            values={{
              service_id: str(s.id)
            }}
            returnTo={route}
          />}
        </div>
      </div>)}
    </div> : <Empty title="No services yet">
      <Link href="/creator/services/new" className="text-link">Create your first service →</Link>
    </Empty>}
  </main>;
}
