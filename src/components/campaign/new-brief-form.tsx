import { CommandForm, Field } from '@/components/ui';
import { TimeField } from '@/components/time-field';
import { FileUploadField } from '@/components/files/file-upload-field';
import { BriefTypePicker } from '@/components/campaign/brief-type-picker';
import { BriefSteps } from '@/components/campaign/brief-steps';
import { GOAL_PAGES } from '@/modules/requests/goal-pages';
import type { CampaignGoal } from '@/modules/requests/goals';

/**
 * The brief a buyer posts, in three steps. Shared by the full page at /buyer/requests/new and by the dialog that
 * opens the same route over whatever page the buyer was on, so both ask exactly the same questions.
 */
export function NewBriefForm({ performanceEnabled, goal }: { performanceEnabled: boolean; goal: CampaignGoal | null }) {
  // Arriving from a campaign tab, the examples in the form match that kind of campaign.
  const example = goal ? GOAL_PAGES[goal] : null;
  return <CommandForm command="create_request" label="Publish brief" returnTo="/requests">
    {/* Three short questions instead of one long page: what the campaign is, what it asks for, what it pays. */}
    <BriefSteps labels={['Campaign', 'Brief', 'Budget']}>
      <BriefTypePicker performanceEnabled={performanceEnabled} initialGoal={goal} />
      <div>
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
      </div>
      <div>
        <h3 className="brief-section">Budget and timing</h3>
        <div className="form-grid">
          <Field name="budget" label="Total budget (USD, optional if you set a cap)" type="number" placeholder="150" />
          <Field name="per_creator_cap" label="Per creator cap (USD, optional)" type="number" placeholder="50" />
          <Field name="target_hires" label="Creators needed" type="number" value="1" required />
          <TimeField name="application_deadline" label="Applications close (optional)" />
          <TimeField name="deadline" label="Delivery deadline" help="Leave empty for two weeks from today." />
        </div>
      </div>
    </BriefSteps>
  </CommandForm>;
}
