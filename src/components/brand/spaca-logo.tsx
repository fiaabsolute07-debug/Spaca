/**
 * spaca brand marks, redrawn as vectors from the supplied profile logo (three stacked parallelograms
 * on a rounded square). Replace the paths with the original artwork file when it is available.
 */
const BARS = 'M128 106h190l-44 52H84zM146 174h172l-44 52H102zM128 242h174l-44 52H84z';

/** App icon: white bars on a black rounded square. */
export function SpacaIcon({ size = 28, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="30 30 340 340" role="img" aria-label="spaca" focusable="false">
    <rect x="30" y="30" width="340" height="340" rx="68" fill="#000" />
    <path fill="#fff" d={BARS} />
  </svg>;
}

/** Bars only, drawn in currentColor, for use on any background. */
export function SpacaMark({ size = 20, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="80 100 242 198" aria-hidden focusable="false">
    <path fill="currentColor" d={BARS} />
  </svg>;
}

/** Icon + wordmark lockup. `tone` picks the wordmark color; the icon keeps its black square. */
export function SpacaLockup({ size = 26, className }: { size?: number; className?: string }) {
  return <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.36) }}>
    <SpacaIcon size={size} />
    <span style={{ fontSize: Math.round(size * 0.74), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1 }}>spaca</span>
  </span>;
}
