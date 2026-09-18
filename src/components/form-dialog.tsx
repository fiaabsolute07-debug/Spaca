'use client';

import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './form-dialog.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), textarea, select, [tabindex="0"]';

/**
 * A page opened over the page someone was already on — the new-service form over Explore, the brief form over the
 * campaign board. The URL is the page's own, Back or Close returns to where they were, and opening the URL directly
 * (a new tab, a pasted link, a reload) shows the full page instead.
 *
 * `fallback` is where Close goes when there is nothing to go back to, which is what happens when the dialog is the
 * first page of a session.
 */
export function FormDialog({ title, description, fallback = '/explore', children }: { title: string; description?: string; fallback?: string; children: ReactNode }) {
  const router = useRouter();
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = () => {
    if (window.history.length > 1) router.back();
    else router.push(fallback);
  };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    // Start in the first field; the Close button comes before it in the header.
    const body = card.current?.querySelector('[data-dialog-body]');
    (body?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=file]), textarea, a[href], button') ?? card.current?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A select or menu inside the form closes itself first and marks the key as handled.
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); }
      if (event.key !== 'Tab' || !card.current) return;
      const focusable = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once per dialog
  }, []);

  return <div className={styles.backdrop} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={card} className={styles.card} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={styles.head}>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button type="button" className={styles.close} onClick={close} aria-label="Close"><X size={18} aria-hidden /></button>
      </header>
      <div className={styles.body} data-dialog-body>{children}</div>
    </div>
  </div>;
}
