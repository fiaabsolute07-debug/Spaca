import { redirect } from 'next/navigation';
import { CAMPAIGN_GOALS } from '@/modules/requests/goals';

/** The campaigns section opens on its first tab. */
export default function CampaignsPage() {
  redirect(`/campaigns/${CAMPAIGN_GOALS[0]!.slug}`);
}
