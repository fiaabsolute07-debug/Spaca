import { LocalTime } from '../access/local-time';
import { CommandForm, Field, humanize, num, str, type Row } from '../ui';

const STATE_TEXT: Record<string, string> = {
  HELD: 'Time held until payment is confirmed',
  BOOKED: 'Booked',
  COMPLETED: 'Session held',
  NO_SHOW_BUYER: 'Buyer did not attend',
  NO_SHOW_CREATOR: 'Creator no-show reported',
  CANCELLED: 'Cancelled',
};

/** XPL-03: the booked session, its private meeting link and the outcome actions valid right now. */
export function OrderSessionPanel({ order: o, appointment: a, buyer, creator, route }: { order: Row; appointment: Row; buyer: boolean; creator: boolean; route: string }) {
  const state = str(a.state);
  const status = str(o.status);
  const startsAt = new Date(str(a.starts_at)).getTime();
  const now = Date.now();
  const graceOver = now >= startsAt + num(a.no_show_minutes) * 60_000;
  const awaitingOutcome = state === 'BOOKED' && ['FUNDED', 'IN_PROGRESS'].includes(status);
  const freeCancelUntil = new Date(startsAt - num(a.cancel_notice_hours) * 3600_000).toISOString();
  const base = { order_id: str(o.id) };

  return <div className="panel session-panel">
    <h2>Session</h2>
    <ul className="facts">
      <li><span>Starts</span><strong><LocalTime iso={new Date(startsAt).toISOString()} /></strong></li>
      <li><span>Length</span><strong>{Math.round((new Date(str(a.ends_at)).getTime() - startsAt) / 60_000)} minutes</strong></li>
      <li><span>Status</span><strong>{STATE_TEXT[state] ?? humanize(state)}</strong></li>
      <li><span>Creator time zone</span><strong>{str(a.creator_time_zone)}</strong></li>
    </ul>
    {['HELD', 'BOOKED'].includes(state) && <>
      {a.meeting_url
        ? <p><a className="text-link" href={str(a.meeting_url)} target="_blank" rel="noreferrer">Join the meeting ›</a> <span className="muted">Only you and the {buyer ? 'creator' : 'buyer'} can see this link.</span></p>
        : <p className="muted">{creator ? 'Add the meeting link so the buyer can join.' : 'The creator will add the meeting link here.'}</p>}
      <p className="muted">
        {buyer
          ? now < new Date(freeCancelUntil).getTime()
            ? <>You can cancel for a full refund until <LocalTime iso={freeCancelUntil} />. After that, cancelling needs the creator to agree.</>
            : <>The free cancellation period has ended ({num(a.cancel_notice_hours)} hours before the start). Request a cancellation if you cannot attend.</>
          : <>If either side does not join within {num(a.no_show_minutes)} minutes of the start, it can be recorded as a no-show.</>}
      </p>
    </>}
    {creator && ['HELD', 'BOOKED'].includes(state) && <CommandForm variant="secondary" command="set_meeting_link" label={a.meeting_url ? 'Update meeting link' : 'Save meeting link'} values={base} returnTo={route}>
      <Field name="meeting_url" label="Meeting link (https)" required placeholder="https://meet.example.com/…" value={a.meeting_url ? str(a.meeting_url) : undefined} />
    </CommandForm>}
    {creator && awaitingOutcome && now >= startsAt && <>
      <CommandForm command="mark_session" label="Mark session as held" values={{ ...base, outcome: 'COMPLETED' }} returnTo={route}>
        <Field name="note" label="What you covered (the buyer sees this)" type="textarea" required placeholder="Topics covered, decisions and follow-up links (at least 20 characters)." />
      </CommandForm>
      {graceOver && <CommandForm variant="secondary" command="mark_session" label="Buyer did not attend" values={{ ...base, outcome: 'NO_SHOW_BUYER' }} returnTo={route}>
        <Field name="note" label="What happened" type="textarea" required placeholder="How long you waited and how you tried to reach the buyer." />
      </CommandForm>}
    </>}
    {creator && awaitingOutcome && now < startsAt && <p className="muted">You can record the outcome once the session starts.</p>}
    {buyer && awaitingOutcome && graceOver && <CommandForm variant="danger" command="report_creator_no_show" label="Creator did not attend" values={base} returnTo={route}>
      <p className="muted">Support reviews the report. Payment stays on hold until then.</p>
      <Field name="body" label="What happened" type="textarea" required />
    </CommandForm>}
  </div>;
}
