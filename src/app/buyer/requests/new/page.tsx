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
        <h3>If creators post for you (PUBLISH)</h3>
        <p className="muted">Each creator posts on their own account, in their own words, with a sponsorship disclosure. Briefs that ask to hide the sponsorship, fake engagement or promise returns are refused.</p>
        <div className="form-grid">
          <Field name="publish_platform" label="Platform">
            <select name="publish_platform" defaultValue="X">
              {[['X', 'X'], ['INSTAGRAM', 'Instagram'], ['TIKTOK', 'TikTok'], ['YOUTUBE', 'YouTube'], ['NEWSLETTER', 'Newsletter'], ['WEBSITE', 'Website']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field name="publish_format" label="Post format">
            <select name="publish_format" defaultValue="POST">
              {[['POST', 'Post'], ['THREAD', 'Thread'], ['QUOTE_POST', 'Quote post'], ['VIDEO', 'Video'], ['NEWSLETTER_ISSUE', 'Newsletter issue'], ['ARTICLE', 'Article']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field name="min_live_hours" label="Keep posts live for (hours)" type="number" value="72" />
          <Field name="disclosure_text" label="Sponsorship disclosure" value="#ad" />
        </div>
      </CommandForm>
    </div>
  </main>;
}
