import { date, money, str, type Row } from '../ui';

const PAYMENT_LABEL: Record<string, string> = {
  PENDING: 'Not paid yet',
  PROCESSING: 'Processing',
  SUCCEEDED: 'Paid',
  FAILED: 'Failed',
  REFUND_PENDING: 'Refund in progress',
  PARTIALLY_REFUNDED: 'Partly refunded',
  REFUNDED: 'Refunded',
  RETURNED: 'Returned by the bank',
};

const PAYOUT_LABEL: Record<string, string> = {
  NOT_READY: 'Held until the buyer approves',
  READY: 'Ready to release',
  PENDING: 'Being released',
  RELEASED: 'Released to the creator',
  FAILED: 'Release failed, under review',
};

/**
 * ORD-01: the receipt for a paid order, as recorded: amount charged, platform fee, how and when it was paid, and where
 * the money is now. It shows stored values only and computes no totals, because the fee model is not decided.
 */
export function OrderReceiptPanel({ order: o }: { order: Row }) {
  if (!o.funded_at) return null;
  const method = str(o.payment_rail) === 'CRYPTO' ? 'Stablecoin' : str(o.funding_method) === 'BANK_TRANSFER' ? 'Bank transfer' : 'Card';
  const payout = str(o.settlement_status, 'NOT_READY');
  const refunded = Number(o.cancellation_refund_minor ?? 0) > 0;
  return <section className="panel money-panel" aria-labelledby="receipt-heading">
    <h2 id="receipt-heading">Receipt</h2>
    <ul className="facts">
      <li><span>Order</span><strong>#{str(o.id).slice(0, 8)}</strong></li>
      <li><span>Amount charged</span><strong className="is-lead">{money(o.amount_minor)}</strong></li>
      <li><span>Platform fee</span><strong>{money(o.platform_fee_minor)}</strong></li>
      <li><span>Paid with</span><strong>{method}</strong></li>
      <li><span>Paid on</span><strong>{date(o.funded_at)}</strong></li>
      <li><span>Payment</span><strong>{PAYMENT_LABEL[str(o.payment_status)] ?? str(o.payment_status)}</strong></li>
      <li><span>Creator payout</span><strong>{PAYOUT_LABEL[payout] ?? payout}{payout === 'RELEASED' && o.completed_at ? ` · ${date(o.completed_at)}` : ''}</strong></li>
      {refunded && <li><span>Refunded</span><strong>{money(o.cancellation_refund_minor)}</strong></li>}
    </ul>
    <p className="muted">Simulated payment in the local sandbox. No real funds moved.</p>
  </section>;
}
