import { randomUUID } from 'node:crypto';
import { isBuyer } from '@/lib/account';
import { auctionMoneyNote } from '@/lib/environment';
import { listingDefaults } from '@/lib/items';
import { ItemListingForm } from '@/components/items/item-listing-form';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

/** List a web3 item for auction: what it is, how it is delivered, and the auction terms with the seller's collateral. */
export default async function NewItemListingPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const { actor, prompt } = await requireActorOrLoginPrompt('/auctions/new', query);
  if (!actor) return prompt;
  return <main className="container items-new">
    <Notices query={query} />
    <PageHeading eyebrow="Auctions · New listing" title="List an item"
      description="Describe exactly what the winner receives and how. After you create the listing, lock the collateral to open bidding." />
    <ItemListingForm idempotencyKey={randomUUID()} canSellAsProject={isBuyer(actor)} defaults={listingDefaults(Date.now())} moneyNote={auctionMoneyNote()} />
  </main>;
}
