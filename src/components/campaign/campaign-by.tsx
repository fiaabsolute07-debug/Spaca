import { Avatar } from '@/components/avatar';
import { str } from '../ui';

/**
 * Who is running a campaign: the project's logo beside its name, both from the buyer's setup (drizzle/0031).
 * A project that has not uploaded a logo yet falls back to the initial the Avatar draws, never to a blank space.
 */
export function CampaignBy({ name, avatarAssetId, size = 18, prefix = 'by' }: {
  name: unknown;
  avatarAssetId?: unknown;
  size?: number;
  prefix?: string;
}) {
  const project = str(name);
  if (!project) return null;
  return <span className="campaign-by">
    <Avatar name={project} assetId={avatarAssetId} size={size} />
    <span>{prefix} <strong>{project}</strong></span>
  </span>;
}
