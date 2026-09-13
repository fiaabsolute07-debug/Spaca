import { CommandForm, Field } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CategoryField } from '@/components/category-field';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function NewServicePage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/creator/services/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Creator setup"
      title="Offer a clear next step."
      description="A service needs a real scope, price, samples, and capacity before it can be published."
    />
    <div className="panel">
      <CommandForm command="create_service" label="Save draft service" returnTo="/creator/services">
        <div className="form-grid">
          <Field
            name="title"
            label="Service title"
            required
            placeholder="Launch story and landing page copy"
          />
          <CategoryField />
          <Field name="price" label="Price (USD)" type="number" required placeholder="500" />
          <Field name="capacity" label="Available slots" type="number" value="3" required />
          <Field name="turnaround_hours" label="Delivery time (hours)" type="number" value="72" required />
          <Field name="niche" label="Niche or specialty" placeholder="Brand strategy, video, design…" />
        </div>
        <Field
          name="description"
          label="Scope and deliverables"
          type="textarea"
          required
          placeholder="What the buyer receives, what is out of scope, and what a complete brief includes."
        />
        <h3>Work samples</h3>
        <div className="form-grid">
          <Field name="sample_url_1" label="Sample URL 1" required />
          <Field name="sample_title_1" label="Sample title 1" required />
          <Field name="sample_url_2" label="Sample URL 2" required />
          <Field name="sample_title_2" label="Sample title 2" required />
          <Field name="sample_url_3" label="Sample URL 3" required />
          <Field name="sample_title_3" label="Sample title 3" required />
        </div>
        <p className="muted">
          The draft is created first. Publishing is a separate action so you can review
          the final scope.
        </p>
      </CommandForm>
    </div>
  </main>;
}
