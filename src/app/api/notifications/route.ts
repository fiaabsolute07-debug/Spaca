import { jsonRoute } from '@/lib/json-route';
import { listInbox, unreadCount } from '@/modules/notifications/inbox';

/** POST → { unread, items } for the header's bell, loaded when it opens. POST so the same-origin check applies. */
export async function POST(request: Request) {
  return jsonRoute(request, async (actor) => {
    const [unread, items] = await Promise.all([unreadCount(actor!.id), listInbox(actor!.id, 12)]);
    return { unread, items };
  });
}
