import Link from 'next/link';
import { GoalIcon } from './goal-icon';
import { CAMPAIGN_GOALS, type CampaignGoal } from '@/modules/requests/goals';

/** The seven campaign tabs. Each is its own page; the count is open campaigns for that goal. */
export function GoalTabs({ current, counts }: { current: CampaignGoal | null; counts: Record<string, number> }) {
  return <nav className="goal-tabs" aria-label="Campaign goals">
    {CAMPAIGN_GOALS.map((goal) => <Link key={goal.value} href={`/campaigns/${goal.slug}`} className="goal-tab" aria-current={current === goal.value ? 'page' : undefined}>
      <GoalIcon goal={goal.value} size={16} />
      <span>{goal.title}</span>
      <span className="goal-count">{counts[goal.value] ?? 0}</span>
    </Link>)}
  </nav>;
}
