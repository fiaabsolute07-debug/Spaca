import Link from 'next/link';
import { getActor, type Actor } from '@/lib/auth';
import type { ReactElement } from 'react';
import { accountTypeMessage, type AccountType } from '@/lib/account';
import { Empty } from './ui';
import { PageHeading } from './page-heading';
import { Notices } from './notices';
import type { Query } from './page-props';
type ActorOrLoginPrompt = {
  actor: Actor;
  prompt: null;
} | {
  actor: null;
  prompt: ReactElement;
};

/** Signed-in actor, or a login prompt. With `accountType`, accounts of the other type get an explanation instead. */
export async function requireActorOrLoginPrompt(route: string, query: Query, accountType?: AccountType): Promise<ActorOrLoginPrompt> {
  const actor = await getActor();
  const notices = <Notices query={query} />;
  if (actor && accountType && !actor.roles.includes(accountType)) {
    return {
      actor: null,
      prompt: <main className="container">
        {notices}
        <PageHeading eyebrow={actor.roles.includes('creator') ? 'Creator account' : 'Buyer account'}
          title={accountType === 'creator' ? 'This page is for creator accounts' : 'This page is for buyer accounts'}
          description={accountTypeMessage(accountType)} />
        <Link className="text-link" href="/dashboard">Back to your workspace ›</Link>
      </main>
    };
  }
  if (actor) return {
    actor,
    prompt: null
  };
  return {
    actor: null,
    prompt: <main className="container">
      {notices}
      <Empty title="Your workspace is one login away">
        <Link className="button button-dark" href={`/sign-in?return_to=${encodeURIComponent(route)}`}>Log in to continue</Link>
      </Empty>
    </main>
  };
}
