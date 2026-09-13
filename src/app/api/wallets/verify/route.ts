import { publicUrl } from '@/lib/auth';
import { jsonRoute, readInput } from '@/lib/json-route';
import { verifyWalletChallenge } from '@/modules/crypto/wallets';

/** POST challenge_id, signature → { wallet_id, address, chain_id }. The challenge is single-use and bound to this site. */
export async function POST(request: Request) {
  return jsonRoute(request, async (actor) => {
    const input = await readInput(request);
    return verifyWalletChallenge(actor!, { challengeId: input.challenge_id ?? '', signature: input.signature ?? '', domain: publicUrl(request, '/').host });
  });
}
