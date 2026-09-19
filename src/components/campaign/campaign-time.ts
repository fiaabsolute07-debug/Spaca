/** How a campaign's closing date reads on a board row and on a card, so both say the same thing. */

const DAY = 24 * 60 * 60 * 1000;

/** The day alone; the full time is on the campaign's own page, where there is room for it. */
export const shortDate = (value: unknown) =>
  new Date(String(value)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** How long is left to apply, in the words a creator scanning the board would use. */
export function closesIn(deadline: unknown): string | null {
  if (!deadline) return null;
  const left = new Date(String(deadline)).getTime() - Date.now();
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'Closed';
  const days = Math.floor(left / DAY);
  if (days >= 2) return `${days} days left`;
  const hours = Math.max(1, Math.floor(left / (60 * 60 * 1000)));
  return hours >= 24 ? '1 day left' : `${hours}h left`;
}
