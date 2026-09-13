import { CommandForm, Field } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CategoryField } from '@/components/category-field';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function NewRequestPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/buyer/requests/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Buyer setup"
      title="Share the project behind the ask."
      description="Give creators enough context to respond with a useful approach and quote."
    />
    <div className="panel">
      <CommandForm command="create_request" label="Publish brief" returnTo="/requests">
        <Field
          name="title"
          label="Brief title"
          required
          placeholder="Three launch videos for our new product"
        />
        <CategoryField />
        <Field
          name="brief"
          label="Brief"
          type="textarea"
          required
          placeholder="Audience, goals, deliverables, references, and constraints."
        />
        <div className="form-grid">
          <Field name="budget" label="Total budget (USD, optional if you set a cap)" type="number" placeholder="1200" />
          <Field name="per_creator_cap" label="Per creator cap (USD, optional)" type="number" placeholder="400" />
          <Field name="target_hires" label="Creators needed" type="number" value="1" required />
          <Field name="application_deadline" label="Applications close (optional)" type="datetime-local" />
          <Field name="deadline" label="Delivery deadline" type="datetime-local" required />
        </div>
      </CommandForm>
    </div>
  </main>;
}
