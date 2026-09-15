import { CommandForm, Field, date, money, num, str, type Row } from '../ui';
import { mockPaymentsEnabled } from '@/modules/payments/funding';
import { CryptoPaymentPanel } from '../crypto/crypto-payment-panel';
import { BankTransferPanel } from './bank-transfer-panel';

type Props = {
  order: Row;
  buyer: boolean;
  creator: boolean;
  actorId: string;
  reviews: Row[];
  latestDeliveryVersion: number | null;
  activeCancellation: Row | null;
  activeHold: Row | null;
  cryptoPayment?: Row | null;
  cryptoOptions?: Row[];
  digital?: boolean;
  /** Buyer only: whether bank transfer is offered and the latest bank transfer, if any (BNK-01). */
  bankTransfer?: Row | null;
  route: string;
};

const ACTIVE_WORK = ['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED'];

/** Actions per master §7.2; the server re-checks every rule, the UI only offers what is currently valid. */
export function OrderNextStepPanel({ order: o, buyer, creator, actorId, reviews, latestDeliveryVersion, activeCancellation, activeHold, cryptoPayment = null, cryptoOptions = [], digital = false, bankTransfer = null, route }: Props) {
  const status = str(o.status);
  const orderId = str(o.id);
  const briefReady = Boolean(o.brief_ready_at);
  const revisionsLeft = Math.max(0, num(o.revision_limit) - num(o.revision_count));
  const base = { order_id: orderId };
  const onDelivery = latestDeliveryVersion ? { ...base, delivery_version: String(latestDeliveryVersion) } : base;
  const cancellation = activeCancellation;
  const isRequester = cancellation ? str(cancellation.requested_by) === actorId : false;

  return <div className="panel">
    <h2>Next step</h2>

    {activeHold && <p className="notice">
      Automatic approval is paused ({str(activeHold.reason).replaceAll('_', ' ').toLowerCase()}). Opening the delivery restarts
      the full review window.
    </p>}

    {buyer && !briefReady && ['AWAITING_PAYMENT', 'FUNDED'].includes(status) && <CommandForm command="submit_brief" label="Save brief" values={base} returnTo={route}>
      <p className="muted">The work clock starts once funding is confirmed and this brief is complete.</p>
      <Field name="brief" label="Project brief" type="textarea" required placeholder="Product, audience, goal, key message, required facts and links (at least 20 characters)." />
    </CommandForm>}

    {status === 'AWAITING_PAYMENT' && buyer && mockPaymentsEnabled() && !['AWAITING_DEPOSIT', 'PENDING_FINALITY'].includes(str(cryptoPayment?.status)) && str(bankTransfer?.funding_status) !== 'PROCESSING' && <form method="post" action="/api/dev/mock-checkout" className="command-form">
      <input type="hidden" name="order_id" value={orderId} />
      <p className="muted">Local test provider. The order is funded only after the provider&apos;s signed confirmation is verified. No real funds move.</p>
      <button className="button" type="submit">Pay with local test provider</button>
    </form>}

    {buyer && bankTransfer && <BankTransferPanel order={o} bank={bankTransfer} />}

    {status === 'AWAITING_PAYMENT' && buyer && str(bankTransfer?.funding_status) !== 'PROCESSING' && <CryptoPaymentPanel orderId={orderId} intent={cryptoPayment} options={cryptoOptions} route={route} />}

    {status === 'AWAITING_PAYMENT' && creator && <p className="muted">
      Waiting for the buyer&apos;s payment to be confirmed by the payment provider. Work can start once it is funded{briefReady ? '' : ' and the brief is complete'}.
    </p>}

    {status === 'FUNDED' && creator && (briefReady
      ? <CommandForm command="start" label="Start work" values={base} returnTo={route}>
          <p className="muted">Due {date(o.delivery_due_at)}. Starting later does not move this date.</p>
        </CommandForm>
      : <p className="muted">Waiting for the buyer to complete the brief before work can start.</p>)}

    {status === 'DELIVERED' && buyer && latestDeliveryVersion && <>
      <CommandForm command="approve" label={`Approve version ${latestDeliveryVersion}`} values={onDelivery} returnTo={route}>
        <p className="muted">Review by {date(o.review_due_at)}. Approval queues the creator payout; the order completes when the provider confirms.</p>
      </CommandForm>
      {digital
        ? <p className="muted">Files are sold as released. Approve once you have checked them, or open a dispute if they are not as described.</p>
        : revisionsLeft > 0
        ? <CommandForm variant="secondary" command="revision" label="Request included revision" values={onDelivery} returnTo={route}>
            <Field name="body" label={`What should change? (${revisionsLeft} revision left)`} type="textarea" required />
          </CommandForm>
        : <p className="muted">The included revision has been used. You can approve, message the creator or open a dispute.</p>}
    </>}

    {ACTIVE_WORK.includes(status) && (buyer || creator) && <CommandForm variant="danger" command="dispute" label="Open a dispute" values={base} returnTo={route}>
      <Field name="body" label="What went wrong?" type="textarea" required />
    </CommandForm>}

    {['AWAITING_PAYMENT', 'FUNDED'].includes(status) && (buyer || creator) && <CommandForm variant="danger" command="cancel" label="Cancel order" values={base} returnTo={route}>
      <p className="muted">{status === 'FUNDED' ? 'Work has not started, so the full amount is refunded through the provider.' : digital ? 'Your reserved copy is released.' : 'The reserved capacity is released.'}</p>
    </CommandForm>}

    {cancellation && <div className="record">
      <strong>Cancellation requested · refund {money(cancellation.refund_amount_minor)}</strong>
      <p className="prewrap">{str(cancellation.reason)}</p>
      {isRequester
        ? <CommandForm variant="secondary" command="respond_cancellation" label="Withdraw request" values={{ request_id: str(cancellation.id), decision: 'withdraw' }} returnTo={route} />
        : <>
            <CommandForm command="respond_cancellation" label="Accept cancellation" values={{ request_id: str(cancellation.id), decision: 'accept' }} returnTo={route}>
              <p className="muted">The agreed refund is requested from the provider; any remainder is released to the creator.</p>
            </CommandForm>
            <CommandForm variant="secondary" command="respond_cancellation" label="Decline" values={{ request_id: str(cancellation.id), decision: 'reject' }} returnTo={route} />
          </>}
    </div>}

    {!cancellation && ACTIVE_WORK.includes(status) && (buyer || creator) && <CommandForm variant="danger" command="request_cancellation" label="Request cancellation" values={base} returnTo={route}>
      <p className="muted">{digital ? 'The files were delivered, so both sides must agree on the refund amount.' : 'Work has started, so both sides must agree on the refund amount.'}</p>
      <Field name="refund_amount" label={`Refund amount (USD, up to ${money(o.amount_minor)})`} required placeholder="0.00" />
      <Field name="reason" label="Reason" type="textarea" required />
    </CommandForm>}

    {status === 'APPROVED' && <p className="muted">Approved. The creator payout is waiting for provider confirmation; reviews open once the order completes.</p>}

    {status === 'COMPLETED' && buyer && !reviews.some((r) => str(r.reviewer_id) === actorId) && <CommandForm command="review" label="Leave a review" values={base} returnTo={route}>
      <Field name="rating" label="Rating (1–5)" type="number" value="5" required />
      <Field name="body" label="What stood out?" type="textarea" required />
    </CommandForm>}

    {status === 'CANCELLED' && str(o.payment_status) === 'REFUND_PENDING' && buyer && <CommandForm variant="secondary" command="refund" label="Check refund with provider" values={base} returnTo={route}>
      <p className="muted">The refund shows as completed only after the provider confirms it.</p>
    </CommandForm>}

    <div className="fee-note">All state changes are server-authorized and versioned. Fees are recorded on the order; any provider cost is tracked separately.</div>
  </div>;
}
