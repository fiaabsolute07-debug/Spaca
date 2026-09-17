import { redirect } from 'next/navigation';

/** Creator slot auctions were replaced by web3 item auctions (2026-09-17); their old pages lead to the new listing form. */
export default function RetiredCreatorAuctions() {
  redirect('/auctions/new');
}
