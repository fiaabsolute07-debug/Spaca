import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { getActor } from '@/lib/auth';
import { isBuyer } from '@/lib/account';
import { auctionMoneyNote } from '@/lib/environment';
import { FormDialog } from '@/components/form-dialog';
import { ItemListingForm } from '@/components/items/item-listing-form';
import { listingDefaults } from '@/lib/items';

/**
 * "List an item" opened from the auction board or anywhere else in the app: the same form in a dialog over that page,
 * so the auctions being watched stay on screen. Opening /auctions/new directly still shows the full page.
 */
export default async function NewItemListingDialog() {
  const actor = await getActor();
  if (!actor) {
    return <FormDialog title="List an item" fallback="/auctions">
      <p className="muted">Log in to list an item for auction.</p>
      <Link className="button button-dark" href="/sign-in">Log in</Link>
    </FormDialog>;
  }
  return <FormDialog title="List an item" fallback="/auctions"
    description="What the winner receives, how it reaches them, and how it sells — in three short steps.">
    <ItemListingForm idempotencyKey={randomUUID()} canSellAsProject={isBuyer(actor)}
      defaults={listingDefaults(Date.now())} moneyNote={auctionMoneyNote()} />
  </FormDialog>;
}
