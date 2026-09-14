import { discoveryRoute } from '@/modules/discovery/http';
import { parseCreatorSearch } from '@/modules/discovery/params';
import { searchCreators } from '@/modules/discovery/search';

/** GET q, niche, taxonomy, available, sort (relevance|reputation|newest), cursor, limit. */
export async function GET(request: Request) {
  return discoveryRoute(() => searchCreators(parseCreatorSearch(new URL(request.url).searchParams)));
}
