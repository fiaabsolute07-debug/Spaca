import { CommandForm, Field } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { BriefTypePicker } from '@/components/campaign/brief-type-picker';
import { goalBySlug } from '@/modules/requests/goals';
import { GOAL_PAGES } from '@/modules/requests/goal-pages';
import { isFlagEnabled } from '@/modules/admin/policy';
import { sql } from '@/lib/db';
import { FileUploadField } from '@/components/files/file-upload-field';
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
  } = await requireActorOrLoginPrompt(route, query, 'buyer');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const performanceEnabled = await isFlagEnabled(sql, 'PERFORMANCE_CAMPAIGNS_ENABLED');
  const goal = goalBySlug(query.goal);
  // Arriving from a campaign tab, the examples in the form match that kind of campaign.
  const example = goal ? GOAL_PAGES[goal.value] : null;
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Post a brief"
      title="Share the project behind the ask."
      description="Give creators enough context to respond with a useful approach and quote."
    />
    <div className="panel">
      <CommandForm command="create_request" label="Publish brief" returnTo="/requests">
        <BriefTypePicker performanceEnabled={performanceEnabled} initialGoal={goal?.value ?? null} />
        <h3 className="brief-section">About the project</h3>
        <Field
          name="title"
          label="Brief title"
          required
          placeholder={example?.briefTitle ?? 'Three launch videos for our new product'}
        />
        <Field
          name="brief"
          label="Brief"
          type="textarea"
          required
          placeholder={example?.briefText ?? 'Audience, goals, deliverables, references, and constraints.'}
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
      </CommandForm>
    </div>
  </main>;
}
