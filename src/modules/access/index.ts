/**
 * ACCESS sessions (master §6.5, P6-03; XPL-03, CAP-11). A creator's weekly availability plus each service's session
 * terms produce bookable starts; `app.appointments` stores the booked instants, and its exclusion constraint
 * (drizzle/0015) is what actually prevents two sessions, with their buffers, from overlapping.
 * Lock order (§6.4): availability (advisory, shared for bookings) → creator workload → appointment → order.
 */
import { CommandError, integer, type Row, type Tx } from '@/lib/commands';
import { ACCESS_HORIZON_DAYS, candidateStarts, type AvailabilityWindow } from './time';

type Queryable = Tx | import('postgres').Sql;

export const ACCESS_POLICY_VERSION = 'access-v1';
/** The creator records the session outcome within this many hours after it ends. */
export const SESSION_OUTCOME_HOURS = 24;

export type AccessTerms = {
  session_minutes: number;
  buffer_minutes: number;
  cancel_notice_hours: number;
  no_show_minutes: number;
  time_zone: string;
  starts_at: string;
  ends_at: string;
  policy_version: string;
};

export type AccessFields = { sessionMinutes: number; bufferMinutes: number; cancelNoticeHours: number; noShowMinutes: number };

const field = (form: FormData, name: string, fallback: string) => String(form.get(name) ?? '').trim() || fallback;

/** Session terms from a service form; defaults are a 60-minute call, 15-minute buffer, 24h notice, 10-minute grace. */
export function accessFields(form: FormData): AccessFields {
  const sessionMinutes = integer(field(form, 'access_session_minutes', '60'), 'access_session_minutes', 15, 480);
  if (sessionMinutes % 15 !== 0) throw new CommandError('Session length must be a multiple of 15 minutes');
  return {
    sessionMinutes,
    bufferMinutes: integer(field(form, 'access_buffer_minutes', '15'), 'access_buffer_minutes', 0, 120),
    cancelNoticeHours: integer(field(form, 'access_cancel_notice_hours', '24'), 'access_cancel_notice_hours', 0, 168),
    noShowMinutes: integer(field(form, 'access_no_show_minutes', '10'), 'access_no_show_minutes', 5, 60),
  };
}

export function accessTermsOf(terms: unknown): AccessTerms | null {
  const access = (terms as { access?: AccessTerms } | null)?.access;
  return access && typeof access.starts_at === 'string' ? access : null;
}

export async function availabilityFor(db: Queryable, creatorId: string): Promise<{ timeZone: string | null; windows: AvailabilityWindow[] }> {
  const rows = await db<Row[]>`select weekday,start_minute,end_minute,time_zone from app.availability_windows where creator_id=${creatorId} order by weekday,start_minute`;
  return {
    timeZone: rows[0] ? String(rows[0].time_zone) : null,
    windows: rows.map((row) => ({ weekday: Number(row.weekday), startMinute: Number(row.start_minute), endMinute: Number(row.end_minute) })),
  };
}

/** Serializes availability edits against bookings that read it (bookings share the lock). */
export async function lockAvailability(tx: Tx, creatorId: string, mode: 'shared' | 'exclusive'): Promise<void> {
  if (mode === 'shared') await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`availability:${creatorId}`}, 0))`;
  else await tx`select pg_advisory_xact_lock(hashtextextended(${`availability:${creatorId}`}, 0))`;
}

/** Intervals (session + buffer) already taken by held or booked appointments. */
export async function blockedRanges(db: Queryable, creatorId: string, from: Date, to: Date): Promise<Array<[number, number]>> {
  const rows = await db<Row[]>`select starts_at,blocked_until from app.appointments
    where creator_id=${creatorId} and state in ('HELD','BOOKED') and blocked_until > ${from.toISOString()} and starts_at < ${to.toISOString()}`;
  return rows.map((row) => [new Date(row.starts_at).getTime(), new Date(row.blocked_until).getTime()]);
}

/**
 * Free starts for one service: candidate starts whose [start, end + buffer) does not meet a taken range. The new
 * session's own buffer counts too, so the next session never starts inside it.
 */
export async function freeSlots(db: Queryable, input: { creatorId: string; sessionMinutes: number; bufferMinutes: number; from: Date; days: number; now?: Date }): Promise<number[]> {
  const { timeZone, windows } = await availabilityFor(db, input.creatorId);
  if (!timeZone || !windows.length) return [];
  const days = Math.min(Math.max(input.days, 1), 14);
  const starts = candidateStarts({ timeZone, windows, sessionMinutes: input.sessionMinutes, from: input.from, days, now: input.now });
  if (!starts.length) return [];
  const taken = await blockedRanges(db, input.creatorId, new Date(starts[0]!), new Date(starts[starts.length - 1]! + (input.sessionMinutes + input.bufferMinutes) * 60_000));
  return starts.filter((start) => {
    const end = start + (input.sessionMinutes + input.bufferMinutes) * 60_000;
    return !taken.some(([from, to]) => start < to && from < end);
  });
}

export const MAX_SLOT_QUERY_DAYS = 14;
export { ACCESS_HORIZON_DAYS };

/** Inserts the HELD appointment for a new ACCESS order; an overlap is refused by the database. */
export async function holdAppointment(tx: Tx, input: { orderId: string; creatorId: string; startsAt: Date; terms: AccessFields; timeZone: string }): Promise<Row> {
  const endsAt = new Date(input.startsAt.getTime() + input.terms.sessionMinutes * 60_000);
  try {
    const [appointment] = await tx.savepoint((sp) => sp<Row[]>`insert into app.appointments
        (order_id,creator_id,starts_at,ends_at,buffer_minutes,blocked_until,creator_time_zone,cancel_notice_hours,no_show_minutes)
      values (${input.orderId},${input.creatorId},${input.startsAt.toISOString()},${endsAt.toISOString()},${input.terms.bufferMinutes},${endsAt.toISOString()},
        ${input.timeZone},${input.terms.cancelNoticeHours},${input.terms.noShowMinutes}) returning *`);
    return appointment!;
  } catch (error) {
    if ((error as { code?: string }).code === '23P01') throw new CommandError('That time was just booked by someone else. Pick another slot.', 'SLOT_TAKEN');
    throw error;
  }
}

export async function appointmentFor(tx: Tx, orderId: string): Promise<Row | undefined> {
  const [appointment] = await tx<Row[]>`select * from app.appointments where order_id=${orderId} for update`;
  return appointment;
}

/** Buyers cancel freely until the notice period before the session; after that only a mutual cancellation applies. */
export function insideCancelNotice(appointment: Row, now = new Date()): boolean {
  return now.getTime() >= new Date(appointment.starts_at).getTime() - Number(appointment.cancel_notice_hours) * 3600_000;
}
