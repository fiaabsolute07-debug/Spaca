/** spaca mark + wordmark as SVG without a background (same vector as src/components/brand/spaca-logo.tsx). Follows the text color. */
const BARS = 'M128 106h190l-44 52H84zM146 174h172l-44 52H102zM128 242h174l-44 52H84z';

export function SpacaLockup({ size = 28 }: { size?: number }) {
  const width = Math.round(size * 0.92);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.34), color: 'inherit' }}>
    <svg width={width} height={Math.round(width * 188 / 234)} viewBox="84 106 234 188" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={BARS} />
    </svg>
    <span style={{ fontSize: Math.round(size * 0.74), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1 }}>spaca</span>
  </span>;
}
