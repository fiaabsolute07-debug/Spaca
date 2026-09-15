import Link from 'next/link';
import { CommandForm, Field, row, rows, str } from '@/components/ui';
import { getDashboardData } from '@/lib/read-model';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CategoryField } from '@/components/category-field';
import { SelectField } from '@/components/select';
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
  } = await requireActorOrLoginPrompt(route, query, 'creator');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const accounts = rows(row(row(await getDashboardData(actor)).profile).social_accounts);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Creator setup"
      title="Offer a clear next step."
      description="A service needs a real scope, price, and samples before it can be published."
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
        <h3>If you chose PUBLISH</h3>
        <p className="muted">
          PUBLISH means you post on your own channel. Buyers see the account, format, disclosure and how long the post stays up.
          {accounts.length === 0 && <> <Link className="text-link" href="/settings/profile">Link an account first ›</Link></>}
        </p>
        <div className="form-grid">
          <SelectField name="publish_account_id" label="Posting account" defaultValue=""
            options={[{ value: '', label: 'Not a PUBLISH service' }, ...accounts.map(account => ({ value: str(account.id), label: `${account.handle ? `@${str(account.handle)}` : str(account.url)} · ${str(account.platform)}` }))]} />
          <SelectField name="publish_format" label="Post format" defaultValue="POST" options={[{ value: 'POST', label: 'Post' }, { value: 'THREAD', label: 'Thread' }, { value: 'QUOTE_POST', label: 'Quote post' }, { value: 'VIDEO', label: 'Video' }, { value: 'NEWSLETTER_ISSUE', label: 'Newsletter issue' }, { value: 'ARTICLE', label: 'Article' }]} />
          <Field name="min_live_hours" label="Keeps the post live for (hours)" type="number" value="72" />
          <Field name="disclosure_text" label="Sponsorship disclosure" value="#ad" />
        </div>
        <h3>If you chose ACCESS</h3>
        <p className="muted">ACCESS is a live session. After payment you and the buyer agree the time and meeting link in the order messages.</p>
        <div className="form-grid">
          <SelectField name="access_session_minutes" label="Session length" defaultValue="60" options={[30, 45, 60, 90, 120].map((m) => ({ value: String(m), label: `${m} minutes` }))} />
        </div>
        <h3>If you chose DIGITAL</h3>
        <p className="muted">
          DIGITAL sells files you already made (templates, code, presets). Buyers download the file right after paying. Save the draft, upload the file on My services, then publish.
        </p>
        <div className="form-grid">
          <SelectField name="digital_license" label="License" defaultValue="NON_EXCLUSIVE"
            options={[{ value: 'NON_EXCLUSIVE', label: 'Non-exclusive (sell many copies)' }, { value: 'EXCLUSIVE', label: 'Exclusive (one buyer only)' }]} />
          <SelectField name="digital_updates" label="Buyers get" defaultValue="LATEST"
            options={[{ value: 'LATEST', label: 'Every new version' }, { value: 'PURCHASED_VERSION', label: 'Only the version they bought' }]} />
          <Field name="digital_stock" label="Copies for sale (empty = unlimited)" type="number" />
          <Field name="digital_download_limit" label="Downloads per purchase" type="number" value="10" />
        </div>
        <Field name="digital_rights_text" label="What buyers may do with the files" type="textarea" placeholder="For example: use in personal and client projects; do not resell or share the files." />
        <h3>Work samples</h3>
        <p className="muted">One strong sample is enough to publish. Add up to two more if you have them.</p>
        <div className="form-grid">
          <Field name="sample_url_1" label="Sample URL 1" required />
          <Field name="sample_title_1" label="Sample title 1" required />
          <Field name="sample_url_2" label="Sample URL 2" />
          <Field name="sample_title_2" label="Sample title 2" />
          <Field name="sample_url_3" label="Sample URL 3" />
          <Field name="sample_title_3" label="Sample title 3" />
        </div>
        <p className="muted">
          The draft is created first. Publishing is a separate action so you can review
          the final scope.
        </p>
      </CommandForm>
    </div>
  </main>;
}
