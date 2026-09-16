'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { CAMPAIGN_GOALS, type CampaignGoal } from '@/modules/requests/goals';
import { useInView } from './in-view';
import styles from './landing.module.css';

const d = (n: number) => ({ '--d': n }) as CSSProperties;

/**
 * The seven campaign drawings from the brand kit, redrawn with moving parts: the launch dot flies its arc, waves
 * carry out, the parachute sways, the voice wave talks, bubbles rise, a page gets highlighted, the sticker winks.
 * Motion runs only on screen and not at all with reduced motion.
 */
const MOTION: Record<CampaignGoal, ReactNode> = {
  LAUNCH: <>
    <path className={styles.mDot} d="M18 96 Q60 -10 104 40" />
    <path className={styles.mArt} d="M18 104h86" />
    <circle className={styles.mArt} cx="18" cy="96" r="4" />
    <path className={`${styles.mHl} ${styles.mPulse}`} d="M92 30h18l-6 8H86z" />
    <circle className={`${styles.mFill} ${styles.mTraveller}`} r="3.5"><animateMotion dur="3.2s" repeatCount="indefinite" path="M18 96 Q60 -10 104 40" /></circle>
  </>,
  SHILL: <>
    <circle className={styles.mArt} cx="30" cy="60" r="6" />
    <path className={`${styles.mArt} ${styles.mWave}`} style={d(0)} d="M44 42a26 26 0 0 1 0 36" />
    <path className={`${styles.mArt} ${styles.mWave}`} style={d(1)} d="M56 32a40 40 0 0 1 0 56" />
    <path className={`${styles.mDot} ${styles.mWave}`} style={d(2)} d="M68 22a54 54 0 0 1 0 76" />
    <path className={`${styles.mHl} ${styles.mPulse}`} d="M84 52h22l-6 8H78z" />
    <path className={styles.mArt} d="M80 70h20l-6 8H74z" />
  </>,
  AIRDROP: <g className={styles.mSway}>
    <path className={styles.mArt} d="M24 50a36 30 0 0 1 72 0z" />
    <path className={styles.mDot} d="M24 50l30 34M96 50L66 84M60 50v34" />
    <path className={styles.mHl} d="M48 84h24v18H48z" />
  </g>,
  AMA: <>
    <path className={styles.mDot} d="M14 60h92" />
    {[[30, 12], [40, 24], [50, 8], [60, 32], [70, 16], [80, 4], [90, 20], [100, 8]].map(([x, h], i) =>
      <path key={x} className={`${styles.mArt} ${styles.mBar}`} style={d(i)} d={`M${x} ${60 - h!}v${h! * 2}`} />)}
    <path className={`${styles.mHl} ${styles.mPulse}`} d="M56 18h8v8h-8z" />
  </>,
  TESTNET: <>
    <path className={styles.mArt} d="M48 18h24M52 18v28L28 96a6 6 0 0 0 5 8h54a6 6 0 0 0 5-8L68 46V18" />
    <path className={styles.mHl} d="M38 80h44l8 16H30z" />
    <path className={styles.mDot} d="M46 66h28M40 74h40" />
    <circle className={`${styles.mArt} ${styles.mBubble}`} style={d(0)} cx="54" cy="88" r="2.5" />
    <circle className={`${styles.mArt} ${styles.mBubble}`} style={d(1)} cx="64" cy="90" r="2" />
    <circle className={`${styles.mArt} ${styles.mBubble}`} style={d(2)} cx="72" cy="86" r="3" />
  </>,
  EDUCATION: <>
    <path className={styles.mArt} d="M60 34c-12-8-28-10-42-8v62c14-2 30 0 42 8 12-8 28-10 42-8V26c-14-2-30 0-42 8zM60 34v62" />
    <path className={styles.mDot} d="M26 44c10-1 20 1 26 5M26 58c10-1 20 1 26 5M26 72c10-1 20 1 26 5M68 49c6-4 16-6 26-5" />
    <path className={`${styles.mHl} ${styles.mSweep}`} d="M68 60c6-4 16-6 26-5v10c-10-1-20 1-26 5z" />
  </>,
  MEMES: <>
    <path className={styles.mArt} d="M26 26h68v44L70 94H26z" />
    <path className={`${styles.mHl} ${styles.mPeel}`} d="M70 94V70h24z" />
    <circle className={`${styles.mArt} ${styles.mBlink}`} cx="46" cy="50" r="3" />
    <circle className={`${styles.mArt} ${styles.mBlink}`} cx="72" cy="50" r="3" />
    <path className={styles.mArt} d="M44 64c8 8 22 8 30 0" />
  </>,
};

/** One tile per campaign goal, each opening its tab. Counts are open campaigns right now; none are invented. */
export function GoalStrip({ counts }: { counts: Record<string, number> }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return <div ref={ref} className={styles.goalStrip} data-inview={inView || undefined}>
    {CAMPAIGN_GOALS.map((goal) => {
      const open = counts[goal.value] ?? 0;
      return <Link key={goal.value} href={`/campaigns/${goal.slug}`} className={styles.goalTile}>
        <svg className={styles.goalArt} viewBox="0 0 120 120" aria-hidden>{MOTION[goal.value]}</svg>
        <span className={styles.goalTitle}>{goal.title}</span>
        <span className={styles.goalMeta}>{goal.short}</span>
        <span className={styles.goalOpen}>{open > 0 ? `${open} open now` : 'Be the first brief'}</span>
      </Link>;
    })}
  </div>;
}
