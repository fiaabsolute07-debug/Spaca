import { publicUrl } from '@/lib/auth';
import { jsonRoute, readInput } from '@/lib/json-route';
import { createWalletChallenge } from '@/modules/crypto/wallets';

/** POST chain_id, address → { challenge_id, message, expires_at }. Sign `message` with the wallet (personal_sign). */
export async function POST(request: Request) {
  return jsonRoute(request, async (actor) => {
    const input = await readInput(request);
    const site = publicUrl(request, '/');
    return createWalletChallenge(actor!, { chainId: Number(input.chain_id), address: input.address ?? '', domain: site.host, uri: site.origin });
  });
}
