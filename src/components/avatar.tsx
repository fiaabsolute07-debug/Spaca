/** Profile photo when the user added one, otherwise their initial on a neutral circle. */
export function Avatar({ name, assetId, size = 32, className = '' }: { name: unknown; assetId?: unknown; size?: number; className?: string }) {
  const label = String(name ?? '').trim() || 'User';
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.4)) };
  return assetId
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
    ? <img className={`avatar avatar-photo ${className}`} src={`/api/avatars/${String(assetId)}`} alt="" width={size} height={size} style={style} loading="lazy" />
    : <span className={`avatar ${className}`} style={style} aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>;
}
