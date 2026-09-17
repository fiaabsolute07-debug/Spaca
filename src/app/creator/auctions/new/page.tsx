import { getDashboardData } from '@/lib/read-model';
import { SelectField } from '@/components/select';
import { CommandForm, Field, money, row, rows, str } from '@/components/ui';
import { TimeField } from '@/components/time-field';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function NewAuctionPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/creator/auctions/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'creator');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  const services = rows(d.services).filter(s => str(s.status) === 'PUBLISHED');
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Optional discovery"
      title="Auction a specific slot."
      description="An auction reserves one service capacity unit and creates an order only after a winner funds it."
    />
    <div className="panel">
      <CommandForm command="create_auction" label="Schedule auction" returnTo="/auctions">
        <SelectField name="service_id" label="Published service" required placeholder="Select a service"
          options={services.map(s => ({ value: str(s.id), label: `${str(s.title)} · ${money(s.price_minor)}` }))} />
        <div className="form-grid">
          <Field name="starting_price" label="Starting price (USD)" type="number" required />
          <Field name="minimum_increment" label="Minimum increment (USD)" type="number" value="25" required />
          <Field name="buy_now_price" label="Buy now price (optional)" type="number" />
          <TimeField name="starts_at" label="Starts at" required />
          <TimeField name="ends_at" label="Ends at" required />
        </div>
      </CommandForm>
    </div>
  </main>;
}
