import type { ReactNode } from 'react';

const icon = (d: string): ReactNode => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d.split('|').map((path) => <path key={path} d={path} />)}</svg>;

export type Category = { value: string; key: 'create' | 'publish' | 'access' | 'digital'; title: string; need: string; icon: ReactNode };

/** The four kinds of work, as a buyer asks for them. Each has one color (globals.css `.cat-*`). */
export const CATEGORIES: readonly Category[] = [
  { value: 'CREATE', key: 'create', title: 'Create', need: 'Content delivered to you: threads, videos, articles or designs.', icon: icon('M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z') },
  { value: 'PUBLISH', key: 'publish', title: 'Publish', need: 'Creators post about you on their own channel, with a disclosure.', icon: icon('M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z|M15 9a4 4 0 0 1 0 6|M18 6a8 8 0 0 1 0 12') },
  { value: 'ACCESS', key: 'access', title: 'Access', need: 'A live call, AMA or consultation with the creator.', icon: icon('M15 10l5-3v10l-5-3|M3 7h12v10H3z') },
  { value: 'DIGITAL', key: 'digital', title: 'Digital', need: 'Ready-made templates, datasets or files you license.', icon: icon('M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z|M14 3v5h5|M9 14h6|M9 17h4') },
];

export const categoryOf = (value: unknown): Category => CATEGORIES.find((category) => category.value === value) ?? CATEGORIES[0]!;

export function CategoryBadge({ value }: { value: unknown }) {
  const category = categoryOf(value);
  return <span className={`badge badge-cat cat-${category.key}`}>{category.title}</span>;
}
