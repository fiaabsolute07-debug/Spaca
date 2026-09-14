import { discoveryRoute } from '@/modules/discovery/http';
import { parseCreatorSearch } from '@/modules/discovery/params';
import { searchCreators } from '@/modules/discovery/search';

/** GET q, niche, taxonomy, available, available_before, sort (relevance|reputation|availability|newest), cursor, limit. */
export async function GET(request: Request) {
  return discoveryRoute(() => searchCreators(parseCreatorSearch(new URL(request.url).searchParams)));
}
