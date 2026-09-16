import { CommandForm, Field, Badge, Empty, date, num, row, rows, str, type Row } from '../ui';
import { PoolTemplateBuilder } from './pool-template-builder';
import type { PoolNetwork } from '@/modules/pools/service';

/** Amount from its smallest unit, without inventing a dollar value for tokens. */
function amount(value: unknown, decimals: unknown): string {
  const units = BigInt(String(value ?? '0'));
  const places = Number(decimals ?? 0);
  if (places <= 0) return units.toString();
  const base = 10n ** BigInt(places);
  const whole = units / base;
  const rest = (units % base).toString().padStart(places, '0').replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : whole.toString();
}

function RewardItem({ item }: { item: Row }) {
  const kind = str(item.kind);
  if (kind === 'CASH' || kind === 'TOKEN') {
    return <li>
      <span>{kind === 'CASH' ? 'Paid per hire' : 'Token per hire'}</span>
      <strong>{amount(item.amount_atomic, item.decimals)} {str(item.symbol)}</strong>
    </li>;
  }
  return <li>
    <span>{str(item.perk_type).replaceAll('_', ' ').toLowerCase()}{item.required === false ? ' (optional)' : ''}</span>
    <strong>{str(item.description)}</strong>
  </li>;
}

const STATE_LABEL: Record<string, string> = {
  ACTIVE: 'Held for this hire', RELEASE_PENDING: 'Paying out', RELEASED: 'Paid', CANCELLED: 'Returned to the pool',
};
const ENTITLEMENT_LABEL: Record<string, string> = {
  PENDING: 'Waiting for you', FULFILLED: 'Marked delivered', CLAIMED: 'Confirmed by the creator', CANCELLED: 'Cancelled',
};

/**
 * The reward pool behind a campaign. Everyone sees what a hire pays; the buyer also sees balances, funding references,
 * allocations and the perks they still owe. Amounts are shown in their own asset, never converted.
 */
export function PoolPanel({ data, owner, route, requestId, networks, cryptoEnabled, tokenRewards, nftRewards, canCreate }: {
  data: Record<string, unknown> | null;
  owner: boolean;
  route: string;
  requestId: string;
  networks: PoolNetwork[];
  cryptoEnabled: boolean;
  tokenRewards: boolean;
  nftRewards: boolean;
  canCreate: boolean;
}) {
  if (!data) {
    if (!owner || !canCreate) return null;
    return <section className="panel" aria-labelledby="pool-heading">
      <h2 id="pool-heading">Reward pool (optional)</h2>
      <p>Back this campaign with a pool: every applicant quotes the same amount, the money is held on-chain, and each hire is paid from it when you approve the work. You can add token rewards and perks on top.</p>
      {cryptoEnabled
        ? <CommandForm command="create_campaign_pool" label="Create the pool" values={{ request_id: requestId }} returnTo={route}>
            <PoolTemplateBuilder networks={networks} tokenRewards={tokenRewards} nftRewards={nftRewards} />
          </CommandForm>
        : <p className="notice">Crypto checkout is switched off in this environment, so a pool cannot be created right now.</p>}
    </section>;
  }

  const pool = row(data.pool);
  const items = rows(pool.rewards_per_hire);
  const missing = rows(pool.missing_required);
  const assets = rows(data.assets);
  const intents = rows(data.funding_intents);
  const allocations = rows(data.allocations);
  const entitlements = rows(data.entitlements);
  const refunds = rows(data.refunds);
  const status = str(pool.status);

  return <section className="panel" aria-labelledby="pool-heading">
    <div className="inline-actions">
      <h2 id="pool-heading">Reward pool</h2>
      <Badge tone={pool.fully_funded === true ? 'good' : 'waiting'}>{pool.fully_funded === true ? 'Funded' : 'Waiting for funding'}</Badge>
      <Badge>{status.toLowerCase()}</Badge>
      <span className="muted">{str(pool.network_name)} · {str(pool.network_mode).toLowerCase()} · template v{num(pool.template_version)}</span>
    </div>
    <ul className="facts">{items.map((item, index) => <RewardItem key={`${str(item.key)}-${index}`} item={item} />)}</ul>
    {missing.length > 0 && <p className="notice">Still to deposit: {missing.map((item) => `${str(item.missing)} ${str(item.symbol)}`).join(', ')}. Creators can apply, but hires cannot be accepted until the pool is funded.</p>}

    {owner && <>
      <h3>Balances</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Asset</th><th>Target</th><th>Deposited</th><th>Free</th><th>Held</th><th>Paid out</th><th>Refunded</th></tr></thead>
          <tbody>
            {assets.map((asset) => <tr key={str(asset.asset_id)}>
              <td>{str(asset.symbol)}<small>{str(asset.kind).toLowerCase()}</small></td>
              <td>{str(asset.target)}</td>
              <td>{str(asset.confirmed_deposit)}</td>
              <td>{str(asset.unallocated)}</td>
              <td>{str(asset.allocated_active)}</td>
              <td>{str(asset.released)}</td>
              <td>{str(asset.refunded)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      {status !== 'CLOSED' && <div className="pool-actions">
        <CommandForm command="create_pool_funding" label="Get a deposit reference" variant="secondary" values={{ pool_id: str(pool.id) }} returnTo={route}>
          <div className="form-grid">
            <label className="field">
              <span>Asset</span>
              <select name="asset_id" required>
                {assets.map((asset) => <option key={str(asset.asset_id)} value={str(asset.asset_id)}>{str(asset.symbol)} · {str(asset.kind).toLowerCase()}</option>)}
              </select>
            </label>
            <Field name="amount" label="Amount to deposit" required placeholder="500" />
          </div>
          <p className="muted">Send exactly the amount shown with its reference. The deposit counts once the chain confirms it; screenshots are never accepted.</p>
        </CommandForm>
        <CommandForm command="refund_pool_unused" label="Refund free balance" variant="secondary" values={{ pool_id: str(pool.id) }} returnTo={route}>
          <div className="form-grid">
            <label className="field">
              <span>Asset</span>
              <select name="asset_id" required>
                {assets.map((asset) => <option key={str(asset.asset_id)} value={str(asset.asset_id)}>{str(asset.symbol)}</option>)}
              </select>
            </label>
            <Field name="amount" label="Amount (optional: all free balance)" />
          </div>
          <p className="muted">Refunds go to your verified wallet. Money held for a hire cannot be refunded.</p>
        </CommandForm>
        <CommandForm command="close_campaign_pool" label="Close the pool" variant="danger" values={{ pool_id: str(pool.id) }} returnTo={route} />
      </div>}

      {intents.length > 0 && <>
        <h3>Deposits</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Amount</th><th>Send to</th><th>Reference</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {intents.map((intent) => <tr key={str(intent.id)}>
                <td>{amount(intent.amount_atomic, intent.decimals)} {str(intent.symbol)}</td>
                <td className="prewrap">{str(intent.recipient)}</td>
                <td className="prewrap">{str(intent.reference)}</td>
                <td><Badge>{str(intent.status)}</Badge>{intent.status_reason ? <small>{str(intent.status_reason)}</small> : null}</td>
                <td>{date(intent.created_at)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}

      {allocations.length > 0 && <>
        <h3>Held and paid per hire</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Reward</th><th>Amount</th><th>State</th><th>Attempts</th></tr></thead>
            <tbody>
              {allocations.map((allocation) => <tr key={`${str(allocation.order_id)}-${str(allocation.item_key)}`}>
                <td>#{str(allocation.order_id).slice(0, 8)}</td>
                <td>{str(allocation.item_key)}<small>{str(allocation.kind).toLowerCase()}</small></td>
                <td>{amount(allocation.amount_atomic, allocation.decimals)} {str(allocation.symbol)}</td>
                <td>{STATE_LABEL[str(allocation.state)] ?? str(allocation.state)}{allocation.last_error ? <small>{str(allocation.last_error)}</small> : null}</td>
                <td>{num(allocation.attempts)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}

      {entitlements.length > 0 && <>
        <h3>Perks you owe</h3>
        {entitlements.map((entitlement) => <div className="record" key={str(entitlement.id)}>
          <div className="inline-actions">
            <strong>{str(entitlement.description)}</strong>
            <Badge>{ENTITLEMENT_LABEL[str(entitlement.status)] ?? str(entitlement.status)}</Badge>
            <span className="muted">order #{str(entitlement.order_id).slice(0, 8)} · due {date(entitlement.deadline_at)}</span>
          </div>
          {str(entitlement.status) === 'PENDING' && <CommandForm command="fulfill_entitlement" label="Mark as delivered" variant="secondary" values={{ entitlement_id: str(entitlement.id) }} returnTo={route}>
            <Field name="proof" label="How you delivered it (link or reference)" type="textarea" required />
            {str(entitlement.perk_type) === 'NFT' && <div className="form-grid">
              <Field name="nft_contract" label="NFT contract" required />
              <Field name="nft_token_id" label="Token id" required />
            </div>}
          </CommandForm>}
        </div>)}
      </>}

      {refunds.length > 0 && <>
        <h3>Refunds</h3>
        <ul className="facts">
          {refunds.map((refund) => <li key={str(refund.id)}>
            <span>{date(refund.created_at)} · {str(refund.symbol)}</span>
            <strong>{amount(refund.amount_atomic, refund.decimals)} {str(refund.symbol)} · {str(refund.state).toLowerCase()}</strong>
          </li>)}
        </ul>
      </>}

      {assets.length === 0 && <Empty title="No assets yet">This pool has no asset rows, so nothing can be funded.</Empty>}
    </>}
  </section>;
}
