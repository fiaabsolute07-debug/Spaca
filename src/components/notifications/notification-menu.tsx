'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { InboxItem } from '@/modules/notifications/inbox';
import styles from './notifications.module.css';

const CAP = 100;
const countLabel = (count: number) => (count >= CAP ? '99+' : String(count));

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function post(path: string, body: Record<string, string>) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), keepalive: true });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<{ unread: number; items?: InboxItem[] }>;
}

/**
 * The bell beside Fund: an unread count on the icon, and on opening the latest notifications with where each leads.
 * Opening one marks it read; "Mark all read" clears the count. Closes like the other header menus.
 */
export function NotificationMenu({ initialUnread }: { initialUnread: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => setUnread(initialUnread), [initialUnread]);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    post('/api/notifications', {})
      .then((body) => { if (!cancelled) { setItems(body.items ?? []); setUnread(body.unread); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (item: InboxItem) => {
    setOpen(false);
    if (item.read) return;
    setItems((current) => current?.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)) ?? null);
    setUnread((count) => Math.max(0, count - 1));
    void post('/api/notifications/read', { id: item.id }).catch(() => undefined);
  };
  const markAll = () => {
    setItems((current) => current?.map((entry) => ({ ...entry, read: true })) ?? null);
    setUnread(0);
    void post('/api/notifications/read', { all: 'true' }).then((body) => setUnread(body.unread)).catch(() => undefined);
  };

  const label = unread ? `Notifications, ${countLabel(unread)} unread` : 'Notifications';
  return <div className={styles.menu} ref={root}>
    <button ref={button} type="button" className={styles.bell} aria-label={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <Bell size={17} aria-hidden />
      {unread > 0 && <span className={styles.count} aria-hidden>{countLabel(unread)}</span>}
    </button>
    <div id={panelId} className={styles.panel} hidden={!open} role="group" aria-label="Notifications">
      <div className={styles.panelHead}>
        <strong>Notifications</strong>
        {unread > 0 && <button type="button" className={styles.markAll} onClick={markAll}>Mark all read</button>}
      </div>
      {items === null
        ? <p className={styles.note}>{failed ? 'Notifications could not be loaded. Try again.' : 'Loading…'}</p>
        : items.length === 0
          ? <p className={styles.note}>Nothing yet. Orders, offers and payments will show here.</p>
          : <ul className={styles.list}>
            {items.map((item) => <li key={item.id}>
              <Link className={`${styles.item}${item.read ? '' : ` ${styles.unread}`}`} href={item.linkPath} onClick={() => openItem(item)}>
                <span className={styles.dot} aria-hidden />
                <span className={styles.itemText}>
                  <strong>{item.subject}{item.read ? '' : <span className="visually-hidden"> (unread)</span>}</strong>
                  <span>{item.body}</span>
                  <time dateTime={item.createdAt}>{ago(item.createdAt)}</time>
                </span>
              </Link>
            </li>)}
          </ul>}
      <Link className={styles.viewAll} href="/notifications" onClick={() => setOpen(false)}>View all notifications ›</Link>
    </div>
  </div>;
}
