import { requireActorOrLoginPrompt } from '@/components/require-actor';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';
import { Empty } from '@/components/ui';
import { NotificationList } from '@/components/notifications/notification-list';
import styles from '@/components/notifications/notifications.module.css';
import { listInbox, unreadCount } from '@/modules/notifications/inbox';

export const dynamic = 'force-dynamic';

/** Every in-app notification, newest first (the bell shows the latest few). */
export default async function NotificationsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const { actor, prompt } = await requireActorOrLoginPrompt('/notifications', query);
  if (!actor) return prompt;
  const [items, unread] = await Promise.all([listInbox(actor.id, 100), unreadCount(actor.id)]);
  return <main className={`container ${styles.page}`}>
    <Notices query={query} />
    <div className={styles.pageHead}>
      <PageHeading eyebrow="Notifications" title="What changed" description="Orders, offers, payments and reviews, newest first." />
      {unread > 0 && <form method="post" action="/api/notifications/read">
        <button className="button button-outline compact" type="submit">Mark all read</button>
      </form>}
    </div>
    {items.length ? <NotificationList items={items} /> : <Empty title="No notifications yet">Orders, offers and payments will show here.</Empty>}
  </main>;
}
