'use client';

import { useEffect, useState } from 'react';
import styles from './landing.module.css';
import { THEME_ATTRIBUTE as ATTRIBUTE, THEME_STORAGE_KEY } from './theme-boot';

export type LandingTheme = 'light' | 'dark';

function effectiveTheme(): LandingTheme {
  const stored = document.documentElement.getAttribute(ATTRIBUTE);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Segmented light/dark switch: a pill with a sliding thumb. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<LandingTheme | null>(null);

  useEffect(() => {
    setTheme(effectiveTheme());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => setTheme(effectiveTheme());
    media.addEventListener('change', onSystemChange);
    return () => media.removeEventListener('change', onSystemChange);
  }, []);

  function choose(next: LandingTheme) {
    setTheme(next);
    document.documentElement.setAttribute(ATTRIBUTE, next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing: the choice lasts for this page view only.
    }
  }

  return <div className={styles.themeToggle} role="radiogroup" aria-label="Color theme" data-value={theme ?? 'unset'}>
    <span className={styles.themeThumb} aria-hidden />
    <button type="button" role="radio" aria-checked={theme === 'light'} aria-label="Light theme" className={styles.themeOption} onClick={() => choose('light')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
    </button>
    <button type="button" role="radio" aria-checked={theme === 'dark'} aria-label="Dark theme" className={styles.themeOption} onClick={() => choose('dark')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
    </button>
  </div>;
}
