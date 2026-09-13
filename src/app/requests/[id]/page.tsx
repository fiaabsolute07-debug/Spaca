import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getRequestData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, date, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function RequestPage({
  params,
  searchParams
}: PageProps<{
  id: string;
}>) {
  const query = await searchParams;
  const {
    id
  } = await params;
  const route = `/requests/${id}`;
  const actor = await getActor();
  const notices = <Notices query={query} />;
  const result = await getRequestData(actor, id);
  if (!result) notFound();
  const d = row(result),
    r = row(d.request),
    owner = actor?.id === str(r.buyer_id);
  return <main className="container">
    {notices}
    <Link href="/requests" className="breadcrumbs">← All open briefs</Link>
    <PageHeading
      eyebrow={str(r.taxonomy)}
      title={str(r.title)}
      description={`Posted by ${str(r.buyer_name)} · ${str(r.status)}`}
    />
    <div className="split">
      <div>
        <div className="panel">
          <h2>The brief</h2>
          <p className="prewrap">
            {str(r.brief)}
          </p>
          <ul className="facts">
            <li>
              Budget
              <strong>
                {money(r.budget_minor)}
              </strong>
            </li>
            <li>
              Creators needed
              <strong>
                {num(r.target_hires)}
              </strong>
            </li>
            <li>
              Deadline
              <strong>
                {date(r.deadline)}
              </strong>
            </li>
          </ul>
        </div>
        <div className="panel">
          <h2>
            {owner ? 'Compare applications' : 'Your applications'}
          </h2>
          {rows(d.applications).length ? rows(d.applications).map(a => <div className="record" key={str(a.id)}>
            <div className="inline-actions">
              <h3>
                {str(a.creator_name)}
              </h3>
              <Badge>
                {str(a.status)}
              </Badge>
            </div>
            <p>
              {str(a.note)}
            </p>
            <p>
              <strong>
                {money(a.quote_minor)}
              </strong>
            </p>
            {owner && str(a.status) === 'SUBMITTED' && <CommandForm
              command="select_application"
              label="Select creator"
              values={{
                application_id: str(a.id)
              }}
              returnTo={route}
            />}
            {" "}
            {!owner && str(a.status) === 'SELECTED' && <>
              <CommandForm
                command="accept_offer"
                label="Accept offer"
                values={{
                  application_id: str(a.id)
                }}
              />
              <CommandForm
                command="decline_offer"
                label="Decline offer"
                values={{
                  application_id: str(a.id)
                }}
                returnTo={route}
              />
            </>}
          </div>) : (
            <Empty title="No applications to show">
              Applications are visible to the buyer and their respective creators.
            </Empty>
          )}
        </div>
      </div>
      <aside className="panel">
        <h2>
          {owner ? 'Your brief is live' : 'Bring your approach'}
        </h2>
        {!owner && actor ? <CommandForm
          command="apply"
          label="Send application"
          values={{
            request_id: str(r.id)
          }}
          returnTo={route}
        >
          <Field name="quote" label="Your quote (USD)" type="number" required />
          <Field name="turnaround_hours" label="Delivery time (hours)" type="number" value="48" required />
          <Field name="note" label="Your approach and relevant samples" type="textarea" required />
        </CommandForm> : !actor ? <Link className="button button-dark" href="/sign-in">Log in to apply ↗</Link> : <p>
          Review the work samples and scope before selecting a creator. The lowest quote
          does not automatically win.
        </p>}
      </aside>
    </div>
  </main>;
}
