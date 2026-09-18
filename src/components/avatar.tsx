/**
 * Profile photo when the user added one; otherwise the photo from their connected X account, which is what an
 * account made with X has before it uploads anything; otherwise their initial on a neutral circle.
 */
export function Avatar({ name, assetId, imageUrl, size = 32, className = '' }: { name: unknown; assetId?: unknown; imageUrl?: unknown; size?: number; className?: string }) {
  const label = String(name ?? '').trim() || 'User';
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.4)) };
  if (assetId) {
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
    return <img className={`avatar avatar-photo ${className}`} src={`/api/avatars/${String(assetId)}`} alt="" width={size} height={size} style={style} loading="lazy" />;
  }
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- X's own CDN; no referrer, as on the X profile card
    return <img className={`avatar avatar-photo ${className}`} src={String(imageUrl)} alt="" width={size} height={size} style={style} loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <span className={`avatar ${className}`} style={style} aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>;
}
