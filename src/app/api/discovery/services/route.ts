import { discoveryRoute } from '@/modules/discovery/http';
import { parseServiceSearch } from '@/modules/discovery/params';
import { searchServices } from '@/modules/discovery/search';

/** GET q, taxonomy, niche, price_min, price_max, turnaround_max, available, creator, sort, cursor, limit. */
export async function GET(request: Request) {
  return discoveryRoute(() => searchServices(parseServiceSearch(new URL(request.url).searchParams)));
}
