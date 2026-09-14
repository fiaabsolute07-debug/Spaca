'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './landing.module.css';

type Option = { value: string; label: string; soon?: boolean };
type SlotKey = 'launch' | 'count' | 'creator' | 'when';

const SLOTS: Record<SlotKey, { heading: string; options: Option[] }> = {
  launch: { heading: 'What are you launching?', options: [
    { value: 'mainnet', label: 'mainnet' }, { value: 'tge', label: 'token launch' }, { value: 'testnet', label: 'testnet campaign' }, { value: 'product', label: 'new product' },
  ] },
  count: { heading: 'How many creators?', options: ['1', '3', '5', '10', '20'].map((n) => ({ value: n, label: n })) },
  creator: { heading: 'Who do you need?', options: [
    { value: 'researchers', label: 'researchers' }, { value: 'thread-writers', label: 'thread writers' }, { value: 'analysts', label: 'analysts' },
    { value: 'copywriters', label: 'launch copywriters' }, { value: 'kols', label: 'KOLs · sponsored posts', soon: true }, { value: 'hosts', label: 'Space & AMA hosts', soon: true },
  ] },
  when: { heading: 'When should it go out?', options: [
    { value: '7', label: 'next week' }, { value: '14', label: 'two weeks' }, { value: '30', label: 'a month' },
  ] },
};

function Slot({ slot, value, open, onOpen, onPick }: { slot: SlotKey; value: string; open: boolean; onOpen: () => void; onPick: (value: string) => void }) {
  const { heading, options } = SLOTS[slot];
  const current = options.find((o) => o.value === value)!;
  return <span className={styles.slotWrap} data-slot={slot} data-align={slot === 'when' ? 'end' : undefined}>
    <button type="button" className={styles.slot} aria-haspopup="listbox" aria-expanded={open} onClick={onOpen}>
      {current.label}
      {slot !== 'count' && <svg className={styles.slotChevron} width="0.4em" height="0.4em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>}
    </button>
    {open && <span className={styles.popover} role="listbox" aria-label={heading}>
      <span className={styles.popoverHeading}>{heading}</span>
      {options.map((option) => <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.soon || undefined}
        className={styles.popoverOption}
        onClick={() => !option.soon && onPick(option.value)}
      >
        <span>{option.label}</span>
        {option.soon ? <span className={styles.soon}>Soon</span> : option.value === value
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
          : null}
      </button>)}
    </span>}
  </span>;
}

/** The hero headline is a fill-in campaign brief; each slot is a picker. Selections only prefill the next step. */
export function BriefComposer() {
  const [values, setValues] = useState<Record<SlotKey, string>>({ launch: 'mainnet', count: '5', creator: 'researchers', when: '14' });
  const [open, setOpen] = useState<SlotKey | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const slot = (key: SlotKey) => <Slot
    slot={key}
    value={values[key]}
    open={open === key}
    onOpen={() => setOpen(open === key ? null : key)}
    onPick={(value) => { setValues({ ...values, [key]: value }); setOpen(null); }}
  />;

  const next = new URLSearchParams({ role: 'buyer', launch: values.launch, creators: values.count, creator_type: values.creator, within_days: values.when });

  return <div ref={ref} className={styles.composer}>
    <p className={styles.heroKicker}>Creator campaigns for web3 launches, on X.</p>
    <h1 className={styles.heroTitle}>
      We&apos;re launching a {slot('launch')} and need {slot('count')} {slot('creator')} on X within {slot('when')}.
    </h1>
    <div className={styles.heroActions}>
      <Link className={`${styles.buttonPrimary} ${styles.buttonOnDark}`} href={`/sign-up?${next.toString()}`}>Start this campaign</Link>
      <Link className={styles.heroLink} href="/explore">Browse creators <span aria-hidden>›</span></Link>
      <span className={styles.heroNote}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>Each creator is paid when their work is approved.</span>
    </div>
  </div>;
}
