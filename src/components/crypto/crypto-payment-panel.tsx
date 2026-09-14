import { CommandForm, date, row, rows, str, type Row } from '../ui';
import { CryptoDepositActions } from './crypto-deposit-actions';

const MODE_LABEL: Record<string, string> = { LOCAL: 'LOCAL DEVNET · simulated, no real funds', TESTNET: 'TESTNET · test tokens, no real value' };

export function NetworkBadge({ mode }: { mode: unknown }) {
  return <span className="badge crypto-badge">{MODE_LABEL[str(mode)] ?? str(mode)}</span>;
}

/** Buyer checkout with a USD-pegged asset; instructions come from the server-issued intent (CRY-01 labels). */
export function CryptoPaymentPanel({ orderId, intent, options, route }: { orderId: string; intent: Row | null; options: Row[]; route: string }) {
  const open = intent && ['AWAITING_DEPOSIT', 'PENDING_FINALITY'].includes(str(intent.status));
  if (!open && !options.length) return intent ? <p className="muted">Crypto payment: {str(intent.status).replaceAll('_', ' ')}{intent.status_reason ? ` · ${str(intent.status_reason)}` : ''}</p> : null;
  const deposit = intent?.last_deposit ? row(intent.last_deposit) : null;
  return <div className="record crypto-panel">
    <h3>Pay with stablecoin</h3>
    {open ? <>
      <NetworkBadge mode={intent.network_mode} />
      <ul className="facts">
        <li><span>Fund exactly</span><strong>{str(intent.amount_display)} {str(intent.symbol)}</strong></li>
        <li><span>Network</span><strong>{str(intent.network_name)} (chain {str(intent.chain_id)})</strong></li>
        <li><span>Escrow contract</span><strong className="mono">{str(intent.recipient)}</strong></li>
        <li><span>Escrow bucket</span><strong className="mono">{str(intent.escrow_ref)}</strong></li>
        <li><span>Payment reference</span><strong className="mono">{str(intent.reference)}</strong></li>
        <li><span>Pay before</span><strong>{date(intent.expires_at)}</strong></li>
        <li><span>Status</span><strong>{str(intent.status).replaceAll('_', ' ')}{deposit ? ` · last check: ${str(deposit.status)}${deposit.reason ? ` (${str(deposit.reason)})` : ''}` : ''}</strong></li>
      </ul>
      <p className="muted">Your USDC goes into the spaca escrow contract, not to spaca. It is paid to the creator only after you approve the work, refunded to your wallet if the order is cancelled, and you can reclaim it yourself if nothing happens for 60 days. The order is funded only after the server verifies the deposit on chain.</p>
      <CryptoDepositActions intentId={str(intent.id)} localDevnet={str(intent.network_mode) === 'LOCAL'}
        wallet={intent.token_address ? { chainId: Number(intent.chain_id), chainName: str(intent.network_name), escrow: str(intent.recipient), token: str(intent.token_address), escrowRef: str(intent.escrow_ref), paymentRef: str(intent.reference), amountAtomic: str(intent.amount_atomic) } : null} />
    </> : <>
      {intent && <p className="muted">Previous crypto attempt: {str(intent.status).replaceAll('_', ' ')}{intent.status_reason ? ` · ${str(intent.status_reason)}` : ''}</p>}
      {rows(options).map((option) => <CommandForm variant="secondary" key={`${str(option.chain_id)}-${str(option.asset_id)}`} command="create_crypto_payment"
        label={`Pay ${str(option.amount_display)} ${str(option.symbol)} (${str(option.kind) === 'NATIVE' ? 'native' : 'token'}) on ${str(option.network_name)}`}
        values={{ order_id: orderId, chain_id: str(option.chain_id), asset_id: str(option.asset_id) }} returnTo={route}>
        <NetworkBadge mode={option.mode} />
        <p className="muted">{str(option.kind) === 'NATIVE' ? 'Native' : 'Token interface'} · {str(option.decimals)} decimals</p>
      </CommandForm>)}
    </>}
  </div>;
}
