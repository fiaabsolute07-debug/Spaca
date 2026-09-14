/**
 * ACCESS commands (P6-03, XPL-03): weekly availability, the private meeting link and session outcomes.
 * Booking itself is the `book` command (src/modules/catalog/commands.ts) with `starts_at`.
 */
import { CommandError, httpUrl, orderEvent, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { isValidTimeZone } from '@/modules/capacity/weeks';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { setCryptoEscrowFrozen } from '@/modules/payments/funding';
import { expirePendingCancellation, latestDelivery, resolveReviewHold, termsOf } from '@/modules/orders/lifecycle';
import { orderFor } from '@/modules/orders/commands';
import { appointmentFor, lockAvailability } from '.';
import { parseClock, validateWindows, type AvailabilityWindow } from './time';

const MIN_OUTCOME_NOTE_CHARS = 20;

/** Replaces the creator's weekly windows. Booked sessions keep their instants (XPL-03). */
const setAvailability: CommandHandler = async ({ tx, actor, form }) => {
  if (!actor.roles.includes('creator')) throw new CommandError('Only creators set availability', 'FORBIDDEN');
  const timeZone = text(form, 'time_zone', true, 64);
  if (!isValidTimeZone(timeZone)) throw new CommandError('Time zone is not a valid IANA time zone');
  let parsed: unknown;
  if (form.has('windows')) {
    try {
      parsed = JSON.parse(text(form, 'windows', false, 20000) || '[]');
    } catch {
      throw new CommandError('windows must be a JSON list');
    }
    if (!Array.isArray(parsed)) throw new CommandError('windows must be a JSON list');
  } else {
    // The plain HTML form: day_<1-7>_on, day_<n>_start, day_<n>_end; 23:59 in a time input means end of day.
    parsed = [1, 2, 3, 4, 5, 6, 7].filter((day) => form.get(`day_${day}_on`) === 'on').map((day) => {
      const end = text(form, `day_${day}_end`, true, 5);
      return { weekday: day, start: text(form, `day_${day}_start`, true, 5), end: end === '23:59' ? '24:00' : end };
    });
  }
  let windows: AvailabilityWindow[];
  try {
    windows = (parsed as unknown[]).map((item) => {
      const value = item as { weekday?: unknown; start?: unknown; end?: unknown };
      return { weekday: Number(value.weekday), startMinute: parseClock(String(value.start ?? '')), endMinute: parseClock(String(value.end ?? '')) };
    });
    validateWindows(windows);
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : 'Invalid availability');
  }
  await lockAvailability(tx, actor.id, 'exclusive');
  await tx`delete from app.availability_windows where creator_id=${actor.id}`;
  for (const window of windows) {
    await tx`insert into app.availability_windows (creator_id,weekday,start_minute,end_minute,time_zone)
      values (${actor.id},${window.weekday},${window.startMinute},${window.endMinute},${timeZone})`;
  }
  await tx`update app.users set timezone=${timeZone} where id=${actor.id}`;
  return { path: '/creator/services', message: windows.length ? `Availability saved (${windows.length} weekly window${windows.length === 1 ? '' : 's'}, ${timeZone}). Booked sessions keep their times.` : 'Availability cleared. Buyers cannot book new sessions until you add times.' };
};

/** The meeting link is visible only to the buyer and creator of the order (P6-03). */
const setMeetingLink: CommandHandler = async ({ tx, actor, form }) => {
  const order = await orderFor(tx, actor, uuid(form, 'order_id'));
  const orderId = String(order.id);
  if (actor.id !== String(order.creator_id)) throw new CommandError('Only the creator sets the meeting link', 'FORBIDDEN');
  const appointment = await appointmentFor(tx, orderId);
  if (!appointment || !['HELD', 'BOOKED'].includes(String(appointment.state))) throw new CommandError('This order has no upcoming session', 'ORDER_STATE_CONFLICT');
  const url = httpUrl(text(form, 'meeting_url', true, 1000), 'meeting_url');
  if (!url.startsWith('https://')) throw new CommandError('Use an https meeting link');
  await tx`update app.appointments set meeting_url=${url} where id=${String(appointment.id)}`;
  await orderEvent(tx, orderId, actor.id, 'MEETING_LINK_SET', {});
  return { path: `/orders/${orderId}`, message: 'Meeting link saved. Only you and the buyer can see it.' };
};

/**
 * The creator records what happened: COMPLETED once the session has started, or NO_SHOW_BUYER after the grace
 * period. Either way the order is delivered with the note as evidence, and the buyer can approve or dispute it.
 */
const markSession: CommandHandler = async ({ tx, actor, form }) => {
  const order = await orderFor(tx, actor, uuid(form, 'order_id'));
  const orderId = String(order.id);
  if (actor.id !== String(order.creator_id)) throw new CommandError('Only the creator records the session outcome', 'FORBIDDEN');
  const outcome = text(form, 'outcome');
  if (!['COMPLETED', 'NO_SHOW_BUYER'].includes(outcome)) throw new CommandError('outcome must be COMPLETED or NO_SHOW_BUYER');
  const appointment = await appointmentFor(tx, orderId);
  if (!appointment) throw new CommandError('This order has no session', 'ORDER_STATE_CONFLICT');
  if (!['FUNDED', 'IN_PROGRESS'].includes(String(order.status)) || appointment.state !== 'BOOKED') {
    throw new CommandError(order.status === 'AWAITING_PAYMENT' ? 'Payment is not confirmed yet' : 'The session outcome is already recorded', 'ORDER_STATE_CONFLICT');
  }
  const startsAt = new Date(appointment.starts_at).getTime();
  const now = Date.now();
  if (outcome === 'COMPLETED' && now < startsAt) throw new CommandError('The session has not started yet', 'DOMAIN_RULE');
  if (outcome === 'NO_SHOW_BUYER' && now < startsAt + Number(appointment.no_show_minutes) * 60_000) {
    throw new CommandError(`Wait ${Number(appointment.no_show_minutes)} minutes after the start before marking a no-show`, 'DOMAIN_RULE');
  }
  const note = text(form, 'note', true, 5000);
  if (note.length < MIN_OUTCOME_NOTE_CHARS) throw new CommandError(`Describe the session in at least ${MIN_OUTCOME_NOTE_CHARS} characters`);

  await tx`update app.appointments set state=${outcome},outcome_by=${actor.id},outcome_at=now() where id=${String(appointment.id)}`;
  if (order.status === 'FUNDED') {
    await tx`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`;
    await orderEvent(tx, orderId, actor.id, 'WORK_STARTED', { session: true });
  }
  const version = Number((await latestDelivery(tx, orderId))?.version ?? 0) + 1;
  const body = outcome === 'COMPLETED' ? note : `Buyer did not attend. ${note}`;
  await tx`insert into app.deliveries (order_id,body,url,version,validation_status,submitted_by) values (${orderId},${body},${null},${version},'VALID',${actor.id})`;
  await resolveReviewHold(tx, orderId, 'SUPERSEDED');
  await expirePendingCancellation(tx, orderId);
  const window = termsOf(order).reviewWindowHours;
  const [updated] = await tx<Row[]>`update app.orders set status='DELIVERED',review_due_at=now() + (${window} * interval '1 hour'),revision_due_at=null,
    version=version+1,updated_at=now() where id=${orderId} returning review_due_at`;
  await orderEvent(tx, orderId, actor.id, outcome === 'COMPLETED' ? 'SESSION_COMPLETED' : 'SESSION_NO_SHOW_BUYER', { version, review_due_at: updated!.review_due_at });
  await enqueueNotification(tx, orderId, `notify:order.delivered:${orderId}:v${version}`, {
    templateId: 'order.delivered', recipientId: String(order.buyer_id), params: { orderRef: orderId, reviewDeadlineAt: new Date(updated!.review_due_at).toISOString() },
  });
  return { path: `/orders/${orderId}`, message: outcome === 'COMPLETED' ? 'Session recorded. The buyer can approve it or raise an issue.' : 'No-show recorded. The buyer can approve it or raise an issue.' };
};

/** The buyer reports that the creator did not attend; the order goes to dispute review and the escrow is frozen. */
const reportCreatorNoShow: CommandHandler = async ({ tx, actor, form }) => {
  const order = await orderFor(tx, actor, uuid(form, 'order_id'));
  const orderId = String(order.id);
  if (actor.id !== String(order.buyer_id)) throw new CommandError('Only the buyer can report a creator no-show', 'FORBIDDEN');
  const appointment = await appointmentFor(tx, orderId);
  if (!appointment || appointment.state !== 'BOOKED' || !['FUNDED', 'IN_PROGRESS'].includes(String(order.status))) {
    throw new CommandError('This session is not waiting for an outcome', 'ORDER_STATE_CONFLICT');
  }
  if (Date.now() < new Date(appointment.starts_at).getTime() + Number(appointment.no_show_minutes) * 60_000) {
    throw new CommandError(`Wait ${Number(appointment.no_show_minutes)} minutes after the start before reporting a no-show`, 'DOMAIN_RULE');
  }
  const reason = text(form, 'body', true, 5000);
  if (reason.length < 10) throw new CommandError('Describe what happened in at least 10 characters');
  await tx`update app.appointments set state='NO_SHOW_CREATOR',outcome_by=${actor.id},outcome_at=now() where id=${String(appointment.id)}`;
  if (order.status === 'FUNDED') await tx`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`;
  const [opened] = await tx<Row[]>`insert into app.disputes (order_id,opened_by,reason) values (${orderId},${actor.id},${`Creator no-show: ${reason}`}) returning id`;
  await setCryptoEscrowFrozen(tx, order, String(opened!.id), true);
  await tx`update app.orders set status='DISPUTED',status_before_dispute='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`;
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await expirePendingCancellation(tx, orderId);
  await orderEvent(tx, orderId, actor.id, 'SESSION_NO_SHOW_CREATOR_REPORTED', {});
  await orderEvent(tx, orderId, actor.id, 'DISPUTE_OPENED', { status_before_dispute: 'IN_PROGRESS' });
  await enqueueNotification(tx, orderId, `notify:dispute.opened:${orderId}`, { templateId: 'dispute.opened', recipientId: String(order.creator_id), params: { orderRef: orderId } });
  return { path: `/orders/${orderId}`, message: 'No-show reported. Support reviews it; payment stays on hold until then.' };
};

export const accessCommands: Record<string, CommandHandler> = {
  set_availability: setAvailability,
  set_meeting_link: setMeetingLink,
  mark_session: markSession,
  report_creator_no_show: reportCreatorNoShow,
};
