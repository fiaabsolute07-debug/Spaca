'use client';

import { Download, Megaphone, PenLine, Video, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import styles from './service-type-picker.module.css';

export type ServiceType = 'CREATE' | 'PUBLISH' | 'ACCESS' | 'DIGITAL';

const TYPES: { value: ServiceType; title: string; line: string; icon: LucideIcon }[] = [
  { value: 'CREATE', title: 'Create', line: 'Content you make and deliver', icon: PenLine },
  { value: 'PUBLISH', title: 'Publish', line: 'A post on your own channel', icon: Megaphone },
  { value: 'ACCESS', title: 'Access', line: 'A live session with the buyer', icon: Video },
  { value: 'DIGITAL', title: 'Digital', line: 'Ready-made files to download', icon: Download },
];

/**
 * One choice for the kind of service, with only that kind's terms under it. Every kind's fields stay in the form (the
 * others hidden) so the saved draft carries the same values as before; only what the creator sees changes.
 */
export function ServiceTypePicker({ terms, defaultValue = 'CREATE' }: { terms: Record<ServiceType, ReactNode>; defaultValue?: ServiceType }) {
  const [chosen, setChosen] = useState<ServiceType>(defaultValue);
  return <div className={styles.block}>
    <fieldset className={styles.picker}>
      <legend>What are you offering?</legend>
      <div className={styles.options}>
        {TYPES.map(({ value, title, line, icon: Icon }) => <label key={value} className={styles.option}>
          <input type="radio" name="taxonomy" value={value} checked={chosen === value} onChange={() => setChosen(value)} />
          <span className={styles.icon} aria-hidden><Icon size={18} /></span>
          <strong>{title}</strong>
          <span className={styles.line}>{line}</span>
        </label>)}
      </div>
    </fieldset>
    {TYPES.map(({ value }) => <div key={value} className={styles.terms} hidden={chosen !== value}>{terms[value]}</div>)}
  </div>;
}
