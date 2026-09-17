import { Badge, CommandForm, Field, date, str, type Row } from '../ui';
import { TimeField } from '../time-field';

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Waiting for an answer',
  ACCEPTED: 'Accepted',
  REJECTED: 'Declined',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'Expired: the order changed',
};

/**
 * ORD-12: the deadline moves only when both sides agree. Shows the current deadline, the open proposal with the
 * answer the viewer can give, a form to propose a later date, and the history of agreed changes.
 */
export function OrderDeadlinePanel({ order: o, actorId, amendments, active, route }: { order: Row; actorId: string; amendments: Row[]; active: Row | null; route: string }) {
  const status = str(o.status);
  const due = ['FUNDED', 'IN_PROGRESS'].includes(status) && o.delivery_due_at ? { label: 'Delivery due', at: str(o.delivery_due_at) }
    : status === 'REVISION_REQUESTED' && o.revision_due_at ? { label: 'Revision due', at: str(o.revision_due_at) } : null;
  if (!due && amendments.length === 0) return null;
  const proposer = active && str(active.proposed_by) === actorId;
  return <section className="panel" aria-labelledby="deadline-heading">
    <h2 id="deadline-heading">Deadline</h2>
    {due && <ul className="facts">
      <li><span>{due.label}</span><strong>{date(due.at)}</strong></li>
    </ul>}
    {active ? <div className="record">
      <div className="inline-actions">
        <strong>{proposer ? 'You proposed a new deadline' : `${str(active.proposed_by_name)} proposed a new deadline`}</strong>
        <Badge>{STATUS_LABEL.REQUESTED}</Badge>
      </div>
      <p>{date(active.old_due_at)} → <strong>{date(active.new_due_at)}</strong></p>
      <p className="prewrap muted">{str(active.reason)}</p>
      {proposer
        ? <CommandForm command="respond_deadline_extension" label="Withdraw proposal" variant="secondary" values={{ amendment_id: str(active.id), decision: 'withdraw' }} returnTo={route} />
        : <div className="inline-actions">
          <CommandForm command="respond_deadline_extension" label="Accept new deadline" values={{ amendment_id: str(active.id), decision: 'accept' }} returnTo={route} />
          <CommandForm command="respond_deadline_extension" label="Decline" variant="secondary" values={{ amendment_id: str(active.id), decision: 'reject' }} returnTo={route} />
        </div>}
    </div> : due && <CommandForm command="request_deadline_extension" label="Propose new deadline" variant="secondary" values={{ order_id: str(o.id) }} returnTo={route}>
      <p className="muted">The deadline changes only if the other party accepts. Both of you keep the record.</p>
      <TimeField name="new_due_at" label="New deadline" required value={new Date(new Date(due.at).getTime() + 2 * 86_400_000).toISOString()} />
      <Field name="reason" label="Why more time is needed" type="textarea" required />
    </CommandForm>}
    {amendments.some((a) => str(a.status) !== 'REQUESTED') && <>
      <h3>Changes</h3>
      <ul className="facts">
        {amendments.filter((a) => str(a.status) !== 'REQUESTED').map((a) => <li key={str(a.id)}>
          <span>{date(a.old_due_at)} → {date(a.new_due_at)} · {str(a.proposed_by_name)}</span>
          <strong>{STATUS_LABEL[str(a.status)] ?? str(a.status)}</strong>
        </li>)}
      </ul>
    </>}
  </section>;
}
