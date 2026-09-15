import { CommandForm, Field } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CATEGORIES } from '@/components/category';
import { FileUploadField } from '@/components/files/file-upload-field';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

const PLATFORMS: [string, string][] = [['X', 'X'], ['INSTAGRAM', 'Instagram'], ['TIKTOK', 'TikTok'], ['YOUTUBE', 'YouTube'], ['NEWSLETTER', 'Newsletter'], ['WEBSITE', 'Website']];
const FORMATS: [string, string][] = [['POST', 'Post'], ['THREAD', 'Thread'], ['QUOTE_POST', 'Quote post'], ['VIDEO', 'Video'], ['NEWSLETTER_ISSUE', 'Newsletter issue'], ['ARTICLE', 'Article']];

/** One tap per option: radio chips instead of a dropdown. */
function Chips({ name, legend, options, defaultValue }: { name: string; legend: string; options: [string, string][]; defaultValue: string }) {
  return <fieldset className="choice-group">
    <legend>{legend}</legend>
    <div className="choice-chips">
      {options.map(([value, label]) => <label key={value} className="choice-chip">
        <input type="radio" name={name} value={value} defaultChecked={value === defaultValue} />
        <span>{label}</span>
      </label>)}
    </div>
  </fieldset>;
}

export default async function NewRequestPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/buyer/requests/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'buyer');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Post a brief"
      title="Share the project behind the ask."
      description="Give creators enough context to respond with a useful approach and quote."
    />
    <div className="panel">
      <CommandForm command="create_request" label="Publish brief" returnTo="/requests">
        <fieldset className="choice-group">
          <legend>What do you need?</legend>
          <div className="choice-cards">
            {CATEGORIES.map((category, index) => <label key={category.value} className={`choice-card cat-${category.key}`}>
              <input type="radio" name="taxonomy" value={category.value} defaultChecked={index === 0} required />
              <span className="choice-icon">{category.icon}</span>
              <strong>{category.title}</strong>
              <small>{category.need}</small>
            </label>)}
          </div>
        </fieldset>
        <h3 className="brief-section">About the project</h3>
        <Field
          name="title"
          label="Brief title"
          required
          placeholder="Three launch videos for our new product"
        />
        <Field
          name="brief"
          label="Brief"
          type="textarea"
          required
          placeholder="Audience, goals, deliverables, references, and constraints."
        />
        <FileUploadField purpose="REQUEST_IMAGE" name="image_ids" label="Project images (optional)" help="Up to 6 PNG, JPG, GIF or WebP images: product screenshots, brand visuals or references creators should see." maxFiles={6} />
        <h3 className="brief-section">Budget and timing</h3>
        <div className="form-grid">
          <Field name="budget" label="Total budget (USD, optional if you set a cap)" type="number" placeholder="1200" />
          <Field name="per_creator_cap" label="Per creator cap (USD, optional)" type="number" placeholder="400" />
          <Field name="target_hires" label="Creators needed" type="number" value="1" required />
          <Field name="application_deadline" label="Applications close (optional)" type="datetime-local" />
          <Field name="deadline" label="Delivery deadline" type="datetime-local" required />
        </div>
        <div className="publish-terms">
          <h3 className="brief-section">How creators post for you</h3>
          <p className="muted">Each creator posts on their own account, in their own words, with a sponsorship disclosure. Briefs that ask to hide the sponsorship, fake engagement or promise returns are refused.</p>
          <Chips name="publish_platform" legend="Platform" options={PLATFORMS} defaultValue="X" />
          <Chips name="publish_format" legend="Post format" options={FORMATS} defaultValue="POST" />
          <div className="form-grid">
            <Field name="min_live_hours" label="Keep posts live for (hours)" type="number" value="72" />
            <Field name="disclosure_text" label="Sponsorship disclosure" value="#ad" />
          </div>
        </div>
      </CommandForm>
    </div>
  </main>;
}
