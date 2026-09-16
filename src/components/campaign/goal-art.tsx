import type { ReactNode } from 'react';
import type { CampaignGoal } from '@/modules/requests/goals';

/**
 * One line drawing per campaign goal, taken from the approved kit (docs/brand/spaca-brand-kit.html, section
 * "Bảy tab, bảy hình vẽ nét"). Each is drawn the same way: thin strokes in the text colour, a dotted
 * construction line, and exactly one lime-tinted area. A tab is recognised by its drawing, not by a colour
 * of its own, which is why the four category hues were dropped.
 */
const ART: Record<CampaignGoal, ReactNode> = {
  // A launch arc leaving the pad.
  LAUNCH: <>
    <path className="dot" d="M18 96 Q60 -10 104 40" />
    <circle className="art" cx="18" cy="96" r="4" />
    <path className="hl" d="M92 30h18l-6 8H86z" />
    <path className="art" d="M18 104h86" />
  </>,
  // One voice carrying out in widening waves.
  SHILL: <>
    <circle className="art" cx="30" cy="60" r="6" />
    <path className="art" d="M44 42a26 26 0 0 1 0 36M56 32a40 40 0 0 1 0 56" />
    <path className="dot" d="M68 22a54 54 0 0 1 0 76" />
    <path className="hl" d="M84 52h22l-6 8H78z" />
    <path className="art" d="M80 70h20l-6 8H74z" />
  </>,
  // A parachute lowering a package.
  AIRDROP: <>
    <path className="art" d="M24 50a36 30 0 0 1 72 0z" />
    <path className="dot" d="M24 50l30 34M96 50L66 84M60 50v34" />
    <path className="hl" d="M48 84h24v18H48z" />
  </>,
  // A spoken waveform.
  AMA: <>
    <path className="art" d="M20 60v0M30 48v24M40 36v48M50 52v16M60 28v64M70 44v32M80 56v8M90 40v40M100 52v16" />
    <path className="dot" d="M14 60h92" />
    <path className="hl" d="M56 22h8v8h-8z" />
  </>,
  // A flask on the bench.
  TESTNET: <>
    <path className="art" d="M48 18h24M52 18v28L28 96a6 6 0 0 0 5 8h54a6 6 0 0 0 5-8L68 46V18" />
    <path className="hl" d="M38 80h44l8 16H30z" />
    <path className="dot" d="M46 66h28M40 74h40" />
    <circle className="art" cx="72" cy="58" r="3" />
  </>,
  // An open book.
  EDUCATION: <>
    <path className="art" d="M60 34c-12-8-28-10-42-8v62c14-2 30 0 42 8 12-8 28-10 42-8V26c-14-2-30 0-42 8zM60 34v62" />
    <path className="dot" d="M26 44c10-1 20 1 26 5M26 58c10-1 20 1 26 5M68 49c6-4 16-6 26-5" />
    <path className="hl" d="M68 60c6-4 16-6 26-5v10c-10-1-20 1-26 5z" />
  </>,
  // A sticker with a peeled corner.
  MEMES: <>
    <path className="art" d="M26 26h68v44L70 94H26z" />
    <path className="hl" d="M70 94V70h24z" />
    <circle className="art" cx="46" cy="50" r="3" />
    <circle className="art" cx="72" cy="50" r="3" />
    <path className="art" d="M44 64c8 8 22 8 30 0" />
    <path className="dot" d="M18 18l84 84" />
  </>,
};

export function GoalArt({ goal, size, className = '' }: { goal: CampaignGoal; size?: number; className?: string }) {
  return <svg
    className={`goal-art${className ? ` ${className}` : ''}`}
    viewBox="0 0 120 120"
    width={size}
    height={size}
    aria-hidden
  >{ART[goal]}</svg>;
}
