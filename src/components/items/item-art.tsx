import type { ReactNode } from 'react';
import styles from './item-media.module.css';

type Kind = 'ticket' | 'guaranteed' | 'mint' | 'token' | 'allocation' | 'points' | 'airdrop' | 'nft' | 'box';

/** Which drawing fits a free-text item type; anything unrecognised is a box. */
export function artKind(itemType: string): Kind {
  const type = itemType.toLowerCase();
  if (/\bgtd\b|guarant/.test(type)) return 'guaranteed';
  if (/\bwl\b|white\s?list|allow\s?list/.test(type)) return 'ticket';
  if (/airdrop/.test(type)) return 'airdrop';
  if (/point|xp\b/.test(type)) return 'points';
  if (/presale|allocation|seed|round/.test(type)) return 'allocation';
  if (/token|pre-?market|tge|coin/.test(type)) return 'token';
  if (/nft|pfp|\bart\b|collectible/.test(type)) return 'nft';
  if (/mint|fcfs/.test(type)) return 'mint';
  return 'box';
}

const DRAWINGS: Record<Kind, ReactNode> = {
  // A whitelist ticket with its perforation and a check.
  ticket: <>
    <path d="M18 30h84a6 6 0 0 0 0 12v4a6 6 0 0 0 0 12v4a6 6 0 0 0 0 12H18a6 6 0 0 0 0-12v-4a6 6 0 0 0 0-12v-4a6 6 0 0 0 0-12z" />
    <path d="M76 30v44" strokeDasharray="3 4" />
    <path d="M36 52l8 8 16-16" />
  </>,
  // A ticket with a shield: a mint that is held for you.
  guaranteed: <>
    <path d="M18 30h84a6 6 0 0 0 0 12v4a6 6 0 0 0 0 12v4a6 6 0 0 0 0 12H18a6 6 0 0 0 0-12v-4a6 6 0 0 0 0-12v-4a6 6 0 0 0 0-12z" />
    <path d="M76 30v44" strokeDasharray="3 4" />
    <path d="M48 40l12 4v9c0 8-5 13-12 16-7-3-12-8-12-16v-9z" />
    <path d="M43 54l4 4 7-7" />
  </>,
  // A hexagon being struck: a mint.
  mint: <>
    <path d="M60 24l24 14v28L60 80 36 66V38z" />
    <path d="M60 38v28M47 45l13 7 13-7" />
    <path d="M92 26l6-6M96 38h8M86 18v-8" />
  </>,
  // A coin with its edge and a launch arrow.
  token: <>
    <ellipse cx="56" cy="54" rx="24" ry="24" />
    <ellipse cx="56" cy="54" rx="15" ry="15" />
    <path d="M56 45v18M50 51l6-6 6 6" />
    <path d="M86 30l12-12M90 18h8v8" />
  </>,
  // A pie cut into shares: an allocation.
  allocation: <>
    <circle cx="58" cy="54" r="26" />
    <path d="M58 54V28M58 54l22 14M58 54L36 68" />
    <path d="M88 30h14M88 40h10" />
  </>,
  // A star badge with a count.
  points: <>
    <path d="M60 24l8 17 18 2-13 12 4 18-17-9-17 9 4-18-13-12 18-2z" />
    <path d="M90 74h14M97 67v14" />
  </>,
  // A parachute carrying a box.
  airdrop: <>
    <path d="M30 44a30 22 0 0 1 60 0c-5-4-10-4-15 0-5-4-10-4-15 0-5-4-10-4-15 0-5-4-10-4-15 0z" />
    <path d="M30 44l24 22M90 44L66 66M60 44v22" />
    <rect x="50" y="66" width="20" height="16" rx="2" />
  </>,
  // A framed picture.
  nft: <>
    <rect x="30" y="24" width="60" height="60" rx="4" />
    <rect x="38" y="32" width="44" height="44" rx="2" />
    <circle cx="50" cy="46" r="5" />
    <path d="M38 70l14-12 10 8 8-6 12 10" />
  </>,
  // A parcel.
  box: <>
    <path d="M60 24l28 14v30L60 82 32 68V38z" />
    <path d="M32 38l28 14 28-14M60 52v30" />
    <path d="M46 31l28 14" />
  </>,
};

/**
 * The drawing shown when a listing has no picture: a line drawing for the kind of item (ticket for a WL spot, coin for
 * a token, parachute for an airdrop…) on the brand's drawn grid, with the item type written under it.
 */
export function ItemArt({ itemType, size = 'card', decorative = false }: { itemType: string; size?: 'card' | 'hero'; decorative?: boolean }) {
  const kind = artKind(itemType);
  return <div className={`${styles.art} ${size === 'hero' ? styles.artHero : ''}`} data-kind={kind}
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `Drawing of a ${itemType}` })}>
    <svg viewBox="0 0 120 104" aria-hidden focusable="false">{DRAWINGS[kind]}</svg>
    {/* On a card the type is already written beside the drawing. */}
    {decorative ? null : <span className={styles.artLabel}>{itemType}</span>}
  </div>;
}
