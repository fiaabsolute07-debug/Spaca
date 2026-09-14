/** spaca icon + wordmark (same vector as the product app's src/components/brand/spaca-logo.tsx). */
const BARS = 'M128 106h190l-44 52H84zM146 174h172l-44 52H102zM128 242h174l-44 52H84z';

export function SpacaLockup({ size = 28 }: { size?: number }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.36) }}>
    <svg width={size} height={size} viewBox="30 30 340 340" role="img" aria-label="spaca" focusable="false">
      <rect x="30" y="30" width="340" height="340" rx="68" fill="#000" stroke="var(--logo-ring, transparent)" strokeWidth="6" />
      <path fill="#fff" d={BARS} />
    </svg>
    <span style={{ fontSize: Math.round(size * 0.74), fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1 }}>spaca</span>
  </span>;
}
