'use client';

import Link from 'next/link';
import type { InboxItem } from '@/modules/notifications/inbox';
import { ago } from './notification-menu';
import styles from './notifications.module.css';

/** The full list; opening an unread notification marks it read on the way. */
export function NotificationList({ items }: { items: InboxItem[] }) {
  const markRead = (item: InboxItem) => {
    if (item.read) return;
    void fetch('/api/notifications/read', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ id: item.id }), keepalive: true }).catch(() => undefined);
  };
  return <ul className={styles.pageList} aria-label="Notifications">
    {items.map((item) => <li key={item.id}>
      <Link className={`${styles.item}${item.read ? '' : ` ${styles.unread}`}`} href={item.linkPath} onClick={() => markRead(item)}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.itemText}>
          <strong>{item.subject}{item.read ? '' : <span className="visually-hidden"> (unread)</span>}</strong>
          <span>{item.body}</span>
          <time dateTime={item.createdAt} suppressHydrationWarning>{ago(item.createdAt)}</time>
        </span>
      </Link>
    </li>)}
  </ul>;
}
