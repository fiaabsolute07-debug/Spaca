import Link from 'next/link';
import { getActor, type Actor } from '@/lib/auth';
import type { ReactElement } from 'react';
import { Empty } from './ui';
import { Notices } from './notices';
import type { Query } from './page-props';
type ActorOrLoginPrompt = {
  actor: Actor;
  prompt: null;
} | {
  actor: null;
  prompt: ReactElement;
};
export async function requireActorOrLoginPrompt(route: string, query: Query): Promise<ActorOrLoginPrompt> {
  const actor = await getActor();
  if (actor) return {
    actor,
    prompt: null
  };
  const notices = <Notices query={query} />;
  return {
    actor: null,
    prompt: <main className="container">
      {notices}
      <Empty title="Your workspace is one login away">
        <Link className="button button-dark" href={`/sign-in?return_to=${encodeURIComponent(route)}`}>Log in to continue ↗</Link>
      </Empty>
    </main>
  };
}
