/**
 * OPS-02 replay check, run by scripts/restore-rehearsal.ts against the restored database only (DATABASE_URL is set to
 * the isolated copy). Every processed webhook is pushed back through the application's normal processing path; a
 * safe restore answers ALREADY_PROCESSED for each and changes no money, holds, events or queued effects.
 */
import { sql } from '../../src/lib/db';
import { eventFromInboxRow, processVerifiedEvent } from '../../src/modules/payments/funding';

const target = process.env.RESTORE_REPLAY_TARGET ?? '';
if (!/^creator_marketplace_restore_\d{14}$/.test(target) || !String(process.env.DATABASE_URL).endsWith(`/${target}`)) {
  throw new Error('restore-replay runs only against an isolated creator_marketplace_restore_* database');
}

const fingerprint = async () => {
  const [row] = await sql`select
      (select count(*) from app.ledger_entries)::text || ':' || (select coalesce(sum(amount_minor),0) from app.ledger_entries)::text as ledger,
      (select count(*) from app.order_events)::text as events,
      (select count(*) from app.outbox)::text as outbox,
      (select string_agg(id::text || status || payment_status || settlement_status || version::text, ',' order by id) from app.orders) as orders,
      (select count(*) from app.reconciliation_cases)::text as cases,
      (select string_agg(id::text || state, ',' order by id) from app.workload_claims) as claims`;
  return row as Record<string, string>;
};

const before = await fingerprint();
const rows = await sql`select * from app.webhook_inbox where processed_at is not null order by created_at, id`;
const outcomes: Record<string, number> = {};
for (const row of rows) {
  const receipt = await processVerifiedEvent(eventFromInboxRow(row));
  outcomes[receipt.outcome] = (outcomes[receipt.outcome] ?? 0) + 1;
}
const after = await fingerprint();
const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
await sql.end();
console.log(JSON.stringify({ events: rows.length, outcomes, changed }));
