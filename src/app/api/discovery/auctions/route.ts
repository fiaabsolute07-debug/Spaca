import { discoveryRoute } from '@/modules/discovery/http';
import { parseEndingSoon } from '@/modules/discovery/params';
import { endingSoonAuctions } from '@/modules/discovery/search';

/** GET within_hours (1-168), cursor, limit: live auctions ending soonest by server time. */
export async function GET(request: Request) {
  return discoveryRoute(() => endingSoonAuctions(parseEndingSoon(new URL(request.url).searchParams)));
}
