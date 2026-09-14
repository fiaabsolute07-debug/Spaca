import { CommandError } from '@/lib/commands';
import { discoveryRoute } from '@/modules/discovery/http';
import { TAXONOMIES } from '@/modules/discovery/params';
import { trendingServices } from '@/modules/discovery/trending';

/** GET niche?, taxonomy?: trending-v1 with its formula, or a COLD_START list of new services when evidence is insufficient. */
export async function GET(request: Request) {
  return discoveryRoute(async () => {
    const params = new URL(request.url).searchParams;
    const taxonomy = params.get('taxonomy')?.toUpperCase() || null;
    if (taxonomy && !(TAXONOMIES as readonly string[]).includes(taxonomy)) throw new CommandError(`taxonomy must be one of ${TAXONOMIES.join(', ')}`);
    return trendingServices({ niche: params.get('niche')?.trim().slice(0, 80) || null, taxonomy });
  });
}
