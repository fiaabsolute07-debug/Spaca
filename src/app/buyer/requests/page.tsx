import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { WorkspaceRequests } from '@/components/workspace-requests';

export const dynamic = 'force-dynamic';

export default async function WorkspaceRequestsPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/buyer/requests";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'buyer');
  if (!actor) return prompt;

  return <WorkspaceRequests actor={actor} query={query} view="buyer" />;
}
