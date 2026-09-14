import { CommandForm, Field } from './ui';

const REASONS: [string, string][] = [
  ['UNDISCLOSED_PROMOTION', 'Paid promotion without disclosure'],
  ['FAKE_ENGAGEMENT', 'Fake likes, followers or views'],
  ['GUARANTEED_RETURNS', 'Promises returns or price targets'],
  ['DECEPTIVE_SCRIPT', 'Asks to post a deceptive script'],
  ['IMPERSONATION', 'Impersonation or someone else’s account'],
  ['POST_REMOVED_EARLY', 'Post removed before the agreed time'],
  ['SPAM', 'Spam'],
  ['OTHER', 'Something else'],
];

/** MOD-01: a quiet, collapsed report action; moderators resolve it on /admin/moderation. */
export function ReportForm({ targetType, targetId, returnTo, label = 'Report' }: { targetType: string; targetId: string; returnTo: string; label?: string }) {
  return <details className="report-form">
    <summary>{label}</summary>
    <CommandForm command="report_content" label="Send report" variant="secondary" values={{ target_type: targetType, target_id: targetId }} returnTo={returnTo}>
      <Field name="reason" label="What is wrong?">
        <select name="reason" defaultValue="OTHER">
          {REASONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </Field>
      <Field name="details" label="Details for the moderators" type="textarea" required placeholder="What you saw and where (at least 10 characters)." />
    </CommandForm>
  </details>;
}
