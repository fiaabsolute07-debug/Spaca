import { date, money, str, type Row } from '../ui';
import { mockPaymentsEnabled } from '@/modules/payments/funding';

const STATUS_LABEL: Record<string, string> = {
  REQUIRES_ACTION: 'Waiting for your transfer',
  PROCESSING: 'On its way',
  SUCCEEDED: 'Settled',
  FAILED: 'Failed',
  CANCELED: 'Cancelled',
  RETURNED: 'Returned by the bank',
};

function SandboxBankAction({ orderId, outcome, label }: { orderId: string; outcome: string; label: string }) {
  return <form method="post" action="/api/dev/mock-bank-transfer" className="command-form">
    <input type="hidden" name="order_id" value={orderId} />
    <input type="hidden" name="outcome" value={outcome} />
    <button className="button button-outline" type="submit">{label}</button>
  </form>;
}

/**
 * BNK-01: paying by bank transfer. The order is funded only by the provider's confirmation; there is deliberately no way
 * to upload a receipt or screenshot. Local sandbox buttons stand in for the buyer's bank.
 */
export function BankTransferPanel({ order: o, bank }: { order: Row; bank: Row }) {
  const orderId = str(o.id);
  const status = str(o.status);
  const sandbox = mockPaymentsEnabled();
  const transferStatus = str(bank.funding_status, 'REQUIRES_ACTION');
  if (status !== 'AWAITING_PAYMENT') {
    return sandbox && str(o.funding_method) === 'BANK_TRANSFER' && str(o.payment_status) === 'SUCCEEDED'
      ? <SandboxBankAction orderId={orderId} outcome="RETURNED" label="Sandbox: bank returns the transfer" /> : null;
  }
  if (!bank.reference) {
    return bank.enabled ? <form method="post" action="/api/checkout/bank-transfer" className="command-form">
      <input type="hidden" name="order_id" value={orderId} />
      <p className="muted">Bank transfers can take up to 5 days. The order stays reserved meanwhile, and work starts only after the bank confirms the money arrived.</p>
      <button className="button button-outline" type="submit">Pay by bank transfer</button>
    </form> : null;
  }
  return <section className="record" aria-labelledby="bank-transfer-heading">
    <h3 id="bank-transfer-heading">Bank transfer</h3>
    <ul className="facts">
      <li><span>Amount</span><strong>{money(o.amount_minor)}</strong></li>
      <li><span>Payment reference</span><strong>{str(bank.reference)}</strong></li>
      <li><span>Reserved until</span><strong>{bank.hold_until ? date(bank.hold_until) : 'Not reserved'}</strong></li>
      <li><span>Status</span><strong>{STATUS_LABEL[transferStatus] ?? transferStatus}</strong></li>
    </ul>
    <p className="muted">Include the reference with your transfer. The order is funded when the bank confirms through the payment provider; receipts and screenshots are not accepted as payment.</p>
    {sandbox && transferStatus === 'REQUIRES_ACTION' && <SandboxBankAction orderId={orderId} outcome="SENT" label="Sandbox: send the transfer" />}
    {sandbox && ['REQUIRES_ACTION', 'PROCESSING'].includes(transferStatus) && <div className="inline-actions">
      <SandboxBankAction orderId={orderId} outcome="SETTLED" label="Sandbox: bank settles it" />
      <SandboxBankAction orderId={orderId} outcome="FAILED" label="Sandbox: transfer fails" />
    </div>}
  </section>;
}
