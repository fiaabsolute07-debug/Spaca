import type { ReactNode } from 'react';

/**
 * Menu icons that act out what they stand for when their item is hovered: the rocket launches, the megaphone sends
 * out sound, the parachute drops in, and so on. Drawn as plain SVG so each part can move on its own; the motion is
 * CSS in globals.css ("Menu icon motion"), runs once per hover, animates only transform, opacity and stroke offsets,
 * and is off on touch screens and with reduced motion. At rest every icon is a normal, still drawing.
 */
export type MenuIconName =
  | 'launch' | 'shiller' | 'airdrop' | 'ama' | 'testnet' | 'education' | 'memes'
  | 'create' | 'publish' | 'access' | 'digital'
  | 'pay' | 'held' | 'pool' | 'activity' | 'wallet' | 'payout';

const megaphone = <>
  <g className="mi-horn">
    <path d="M3 10v4h3l7 4V6l-7 4z" />
    <path d="M6 14l1.2 5h2.2l-1-4.6" />
  </g>
  <path className="mi-wave mi-wave-1" d="M15.5 10a2.5 2.5 0 0 1 0 4" />
  <path className="mi-wave mi-wave-2" d="M17.5 8a5 5 0 0 1 0 8" />
  <path className="mi-wave mi-wave-3" d="M19.5 6a7.5 7.5 0 0 1 0 12" />
</>;

const DRAWINGS: Record<MenuIconName, ReactNode> = {
  launch: <>
    <circle className="mi-smoke mi-smoke-1" cx="6.2" cy="18" r="2.2" />
    <circle className="mi-smoke mi-smoke-2" cx="3.8" cy="20.2" r="1.6" />
    <g className="mi-rocket">
      <g transform="rotate(45 12 12)">
        <path className="mi-flame" d="M9.8 16.4h4.4c0 2.5-1 4.3-2.2 6-1.2-1.7-2.2-3.5-2.2-6z" />
        <path d="M12 3c3 2.5 4 6 4 10v3H8v-3c0-4 1-7.5 4-10z" />
        <circle cx="12" cy="10" r="1.6" />
        <path d="M8 13l-2.4 2.4V18H8M16 13l2.4 2.4V18H16" />
      </g>
    </g>
  </>,
  shiller: megaphone,
  publish: megaphone,
  airdrop: <g className="mi-chute">
    <path d="M4 11a8 6.5 0 0 1 16 0c-1.3-.9-2.7-.9-4 0-1.3-.9-2.7-.9-4 0-1.3-.9-2.7-.9-4 0-1.3-.9-2.7-.9-4 0z" />
    <path d="M4 11l6 6.2M20 11l-6 6.2M12 11v6.2" />
    <rect x="9.5" y="17" width="5" height="4" rx=".6" />
  </g>,
  ama: <>
    <path className="mi-ring mi-ring-l" d="M4.5 8.5a4.5 4.5 0 0 0 0 6" />
    <path className="mi-ring mi-ring-r" d="M19.5 8.5a4.5 4.5 0 0 1 0 6" />
    <g className="mi-mic">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path className="mi-grill" d="M10.8 6.8h2.4M10.8 9.5h2.4" />
      <path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V21M9 21h6" />
    </g>
  </>,
  testnet: <>
    <g className="mi-flask">
      <path d="M9 3h6M10 3v6l-5 9.5A1.7 1.7 0 0 0 6.5 21h11a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
      <path className="mi-soft" d="M7.3 15h9.4l2 3.7a.9.9 0 0 1-.8 1.3H6.1a.9.9 0 0 1-.8-1.3z" />
    </g>
    <circle className="mi-bubble mi-bubble-1 mi-fill" cx="10.4" cy="17.4" r="1.6" />
    <circle className="mi-bubble mi-bubble-2 mi-fill" cx="14" cy="17.2" r="1.3" />
    <circle className="mi-bubble mi-bubble-3 mi-fill" cx="12" cy="15.6" r="1.1" />
  </>,
  education: <g className="mi-cap">
    <path d="M2 9l10-5 10 5-10 5z" />
    <path d="M6 11v4.4c0 1.5 2.7 3 6 3s6-1.5 6-3V11" />
    <g className="mi-tassel">
      <path d="M20 9.5v5" />
      <circle className="mi-fill" cx="20" cy="15.4" r="1" />
    </g>
  </g>,
  memes: <g className="mi-sticker">
    <path d="M5 4h14v10l-5 6H5z" />
    <path className="mi-peel mi-soft" d="M14 20v-6h5z" />
    <circle className="mi-fill mi-eye-l" cx="9.5" cy="9" r="1" />
    <circle className="mi-fill mi-eye-r" cx="14.5" cy="9" r="1" />
    <path className="mi-mouth" d="M9 12.8c1.6 1.6 4.4 1.6 6 0" />
  </g>,
  create: <>
    <path className="mi-ink" d="M4 21h9" pathLength={1} />
    <g className="mi-pen">
      <path d="M15 4l5 5-9 9H6v-5z" />
      <path d="M13 6l5 5" />
    </g>
  </>,
  access: <>
    <g className="mi-camera">
      <rect x="2.5" y="7" width="13" height="10" rx="2" />
      <path d="M15.5 11l6-3v8l-6-3z" />
      <circle className="mi-lens" cx="9" cy="12" r="2.4" />
    </g>
    <circle className="mi-fill mi-rec" cx="5.4" cy="4.4" r="1.5" />
    <circle className="mi-ring mi-rec-ring" cx="5.4" cy="4.4" r="1.5" />
  </>,
  digital: <>
    <g className="mi-file">
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
    </g>
    <g className="mi-down">
      <path d="M12.5 9.5v6.5M10 13.5l2.5 2.5 2.5-2.5" />
    </g>
  </>,
  pay: <>
    <g className="mi-card">
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M2.5 9.5h19" />
      <rect x="5" y="12.5" width="4" height="3" rx=".6" />
    </g>
    <path className="mi-check" d="M13.5 14.5l2 2 3.5-3.5" pathLength={1} />
  </>,
  held: <>
    <circle cx="12" cy="12" r="9" />
    <path className="mi-minute" d="M12 12V6.5" />
    <path className="mi-hour" d="M12 12l3 2" />
  </>,
  pool: <>
    <circle className="mi-coin" cx="11.7" cy="3.6" r="2.4" />
    <g className="mi-piggy">
      <path d="M5 12.5c0-3.3 3-6 7-6 3.3 0 6 1.8 6.7 4.3h1.8v3.2h-1.8c-.6 1.3-1.6 2.3-2.9 3V19h-2.5v-1.4h-3V19H7.8v-2.6C6 15.4 5 14 5 12.5z" />
      <path d="M10.3 8.4h2.8" />
      <circle className="mi-fill" cx="15.6" cy="10.8" r=".6" />
    </g>
  </>,
  activity: <g className="mi-receipt">
    <path d="M6 3h12v18l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3L6 21z" />
    <path className="mi-line mi-line-1" d="M9 8h6" pathLength={1} />
    <path className="mi-line mi-line-2" d="M9 11.5h6" pathLength={1} />
    <path className="mi-line mi-line-3" d="M9 15h4" pathLength={1} />
  </g>,
  wallet: <>
    <circle className="mi-coin mi-fill" cx="10" cy="7" r="2.1" />
    <g className="mi-purse">
      <path d="M4.5 7H19a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 19 20H4.5A1.5 1.5 0 0 1 3 18.5v-10A1.5 1.5 0 0 1 4.5 7z" />
      <path d="M16 12h4.5v3.5H16a1.75 1.75 0 0 1 0-3.5z" />
    </g>
  </>,
  payout: <>
    <path className="mi-tray" d="M4 14v5h16v-5" />
    <g className="mi-drop">
      <path d="M12 3v10M8 9l4 4 4-4" />
    </g>
  </>,
};

export function MenuIcon({ name }: { name: MenuIconName }) {
  return <svg className={`mi mi-${name}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">{DRAWINGS[name]}</svg>;
}
