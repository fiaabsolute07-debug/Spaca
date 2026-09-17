import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { accountTypeOf } from '@/lib/account';
import { nextPath, onboardingPath } from '@/lib/onboarding';
import { getAccountSummary } from '@/lib/read-model';
import { listEnabledNetworks } from '@/modules/crypto/registry';
import { listVerifiedWallets } from '@/modules/crypto/wallets';
import { getXProfileViews, xConnectAvailable } from '@/modules/x/service';
import { xMode } from '@/modules/x/provider';
import { OnboardingForm } from '@/components/onboarding/onboarding-form';
import { Notices } from '@/components/notices';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

/** Placeholder names given at sign-up; the setup form starts empty instead of showing them. */
const PLACEHOLDER_NAMES = new Set(['New creator', 'New project', 'New member']);

/**
 * Account setup, the first page after sign-up (src/lib/onboarding.ts). Accounts that finished setup go straight on to
 * where they were headed.
 */
export default async function WelcomePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const next = nextPath(typeof query.return_to === 'string' ? query.return_to : '');
  const { actor, prompt } = await requireActorOrLoginPrompt(onboardingPath(next), query);
  if (!actor) return prompt;
  const type = accountTypeOf(actor);
  if (!type) redirect('/dashboard');
  const account = await getAccountSummary(actor);
  if (account.onboarded) redirect(next);
  const [wallets, networks, xProfiles] = await Promise.all([listVerifiedWallets(actor.id), listEnabledNetworks(), getXProfileViews([actor.id])]);
  // An account made with X fills in from it, buyers too; only creators get the connect-X step in the form.
  const x = xProfiles.get(actor.id) ?? null;
  const handleFromX = x && /^[a-z0-9][a-z0-9_-]{2,31}$/.test(x.username.toLowerCase()) ? x.username.toLowerCase() : '';

  return <main className="container onboard-page">
    <Notices query={query} />
    <OnboardingForm
      type={type}
      next={next}
      idempotencyKey={randomUUID()}
      initial={{
        // A connected X account fills in what is still empty; the creator can change any of it.
        name: PLACEHOLDER_NAMES.has(account.name) ? x?.name ?? '' : account.name,
        handle: account.handle ?? handleFromX,
        avatarAssetId: account.avatarAssetId,
        headline: account.headline,
        bio: account.bio || (x && x.description.length >= 40 ? x.description : ''),
        focus: account.focus ? account.focus.split(',').map((item) => item.trim()) : [],
        link: account.link || (x ? `https://x.com/${x.username}` : ''),
      }}
      x={type === 'creator' ? { profile: x, available: xConnectAvailable(), sandbox: xMode() === 'mock' } : null}
      wallets={wallets.map((wallet) => ({ id: String(wallet.id), address: String(wallet.address), network: String(wallet.network_name) }))}
      networks={networks}
    />
  </main>;
}
