import { FlaskConical, Gift, GraduationCap, Image, Megaphone, Mic, Rocket, type LucideIcon } from 'lucide-react';
import type { CampaignGoal } from '@/modules/requests/goals';

const ICONS: Record<CampaignGoal, LucideIcon> = {
  LAUNCH: Rocket,
  AIRDROP: Gift,
  SHILL: Megaphone,
  TESTNET: FlaskConical,
  AMA: Mic,
  EDUCATION: GraduationCap,
  MEMES: Image,
};

export function GoalIcon({ goal, size = 18 }: { goal: CampaignGoal; size?: number }) {
  const Icon = ICONS[goal];
  return <Icon size={size} strokeWidth={2} aria-hidden />;
}
