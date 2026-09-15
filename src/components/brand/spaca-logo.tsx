/**
 * spaca brand marks as SVG: three stacked parallelograms with no background. The bars use currentColor, so the mark
 * is black on light surfaces and white on dark ones wherever its container sets the text color.
 */
export const SPACA_BARS = 'M128 106h190l-44 52H84zM146 174h172l-44 52H102zM128 242h174l-44 52H84z';
/** Tight crop of the bars (234 × 188). */
export const SPACA_VIEWBOX = '84 106 234 188';
const RATIO = 188 / 234;

/** Bars only, in currentColor. `size` is the width. */
export function SpacaMark({ size = 20, className, title }: { size?: number; className?: string; title?: string }) {
  return <svg className={className} width={size} height={Math.round(size * RATIO)} viewBox={SPACA_VIEWBOX} role={title ? 'img' : undefined}
    aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    <path fill="currentColor" d={SPACA_BARS} />
  </svg>;
}

/** Standalone icon (same transparent mark), labelled for assistive tech. */
export function SpacaIcon({ size = 28, className }: { size?: number; className?: string }) {
  return <SpacaMark size={size} className={className} title="spaca" />;
}

/** Mark + wordmark. Both follow the surrounding text color. */
export function SpacaLockup({ size = 26, className }: { size?: number; className?: string }) {
  return <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.34), color: 'inherit' }}>
    <SpacaMark size={Math.round(size * 0.92)} />
    <span style={{ fontSize: Math.round(size * 0.74), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1 }}>spaca</span>
  </span>;
}
