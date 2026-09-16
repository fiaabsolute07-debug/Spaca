'use client';

import { useMemo, useState } from 'react';
import type { PoolNetwork } from '@/modules/pools/service';

type Perk = { perk_type: string; description: string; fulfillment_method: string; deadline_days: string };

const PERK_TYPES: [string, string][] = [['WHITELIST', 'Whitelist spot'], ['ACCESS', 'Private access'], ['COMMUNITY_ROLE', 'Community role'], ['NFT', 'NFT']];
const MAX_PERKS = 3;
const emptyPerk = (): Perk => ({ perk_type: 'WHITELIST', description: '', fulfillment_method: 'Sent by the buyer after the work is approved', deadline_days: '14' });

/**
 * Builds the reward template a campaign pool pays per hire, and puts it in the hidden `items` field the
 * `create_campaign_pool` command reads. Exactly one CASH item sets the price every applicant quotes; token and perk
 * rewards are optional extras. Token and NFT rows appear only while their flags are on.
 */
export function PoolTemplateBuilder({ networks, tokenRewards, nftRewards }: { networks: PoolNetwork[]; tokenRewards: boolean; nftRewards: boolean }) {
  const [chainId, setChainId] = useState(networks[0]?.chain_id ?? 0);
  const [cashAssetId, setCashAssetId] = useState('');
  const [cash, setCash] = useState('100');
  const [tokenAssetId, setTokenAssetId] = useState('');
  const [tokenAmount, setTokenAmount] = useState('');
  const [perks, setPerks] = useState<Perk[]>([]);

  const network = networks.find((item) => item.chain_id === chainId) ?? networks[0];
  const cashAssets = network?.assets.filter((asset) => asset.usd_pegged) ?? [];
  const tokenAssets = network?.assets ?? [];
  const cashAsset = cashAssets.find((asset) => asset.asset_id === cashAssetId) ?? cashAssets[0];
  const tokenAsset = tokenAssets.find((asset) => asset.asset_id === tokenAssetId);
  const perkTypes = PERK_TYPES.filter(([value]) => value !== 'NFT' || nftRewards);

  const items = useMemo(() => {
    const list: Record<string, unknown>[] = [];
    if (cashAsset) list.push({ key: 'cash', kind: 'CASH', required: true, asset_id: cashAsset.asset_id, amount: cash.trim() });
    if (tokenRewards && tokenAsset && tokenAmount.trim()) list.push({ key: 'token', kind: 'TOKEN', required: true, asset_id: tokenAsset.asset_id, amount: tokenAmount.trim() });
    perks.forEach((perk, index) => {
      if (!perk.description.trim()) return;
      list.push({
        key: `perk${index + 1}`, kind: 'PERK', required: true, perk_type: perk.perk_type,
        description: perk.description.trim(), fulfillment_method: perk.fulfillment_method.trim(), deadline_days: Number(perk.deadline_days) || 14,
      });
    });
    return list;
  }, [cash, cashAsset, perks, tokenAmount, tokenAsset, tokenRewards]);

  const updatePerk = (index: number, patch: Partial<Perk>) => setPerks((current) => current.map((perk, at) => (at === index ? { ...perk, ...patch } : perk)));

  if (!network || !cashAsset) return <p className="notice">No network with an allowlisted stable asset is available, so a pool cannot be created here.</p>;

  return <div className="pool-builder">
    <input type="hidden" name="chain_id" value={network.chain_id} />
    <input type="hidden" name="items" value={JSON.stringify(items)} />

    {networks.length > 1 && <fieldset className="choice-group">
      <legend>Network</legend>
      <div className="choice-chips">
        {networks.map((option) => <label key={option.chain_id} className="choice-chip">
          <input type="radio" name="pool_network" value={option.chain_id} checked={option.chain_id === network.chain_id} onChange={() => { setChainId(option.chain_id); setCashAssetId(''); setTokenAssetId(''); }} />
          <span>{option.name} · {option.mode}</span>
        </label>)}
      </div>
    </fieldset>}

    <fieldset className="choice-group">
      <legend>Paid per hire</legend>
      <div className="form-grid">
        <label className="field">
          <span>Amount per creator</span>
          <input inputMode="decimal" value={cash} onChange={(event) => setCash(event.target.value)} aria-describedby="pool-cash-help" />
        </label>
        {cashAssets.length > 1 && <label className="field">
          <span>Paid in</span>
          <select value={cashAsset.asset_id} onChange={(event) => setCashAssetId(event.target.value)}>
            {cashAssets.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.symbol} · {asset.kind.toLowerCase()}</option>)}
          </select>
        </label>}
      </div>
      <small id="pool-cash-help" className="muted">Every applicant quotes exactly this amount. On {network.name} ({network.mode.toLowerCase()}), paid from the pool when you approve the work.</small>
    </fieldset>

    {tokenRewards && tokenAssets.length > 0 && <fieldset className="choice-group">
      <legend>Token reward (optional)</legend>
      <div className="form-grid">
        <label className="field">
          <span>Token</span>
          <select value={tokenAsset?.asset_id ?? ''} onChange={(event) => setTokenAssetId(event.target.value)}>
            <option value="">No token reward</option>
            {tokenAssets.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.symbol} · {asset.kind.toLowerCase()}</option>)}
          </select>
        </label>
        {tokenAsset && <label className="field">
          <span>Amount per creator</span>
          <input inputMode="decimal" value={tokenAmount} onChange={(event) => setTokenAmount(event.target.value)} />
        </label>}
      </div>
      <small className="muted">Tokens are shown to creators by symbol and amount. No dollar value is promised.</small>
    </fieldset>}

    <fieldset className="choice-group">
      <legend>Perks (optional)</legend>
      {perks.map((perk, index) => <div key={index} className="pool-perk">
        <div className="choice-chips">
          {perkTypes.map(([value, label]) => <label key={value} className="choice-chip">
            <input type="radio" name={`perk_type_${index}`} value={value} checked={perk.perk_type === value} onChange={() => updatePerk(index, { perk_type: value })} />
            <span>{label}</span>
          </label>)}
        </div>
        <label className="field">
          <span>What the creator gets</span>
          <input value={perk.description} onChange={(event) => updatePerk(index, { description: event.target.value })} placeholder="A whitelist spot for the mainnet drop" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>How you deliver it</span>
            <input value={perk.fulfillment_method} onChange={(event) => updatePerk(index, { fulfillment_method: event.target.value })} />
          </label>
          <label className="field">
            <span>Within (days)</span>
            <input inputMode="numeric" value={perk.deadline_days} onChange={(event) => updatePerk(index, { deadline_days: event.target.value })} />
          </label>
        </div>
        <button type="button" className="plain-button" onClick={() => setPerks((current) => current.filter((_, at) => at !== index))}>Remove this perk</button>
      </div>)}
      {perks.length < MAX_PERKS && <button type="button" className="button button-outline compact" onClick={() => setPerks((current) => [...current, emptyPerk()])}>Add a perk</button>}
      <small className="muted">You promise each perk yourself and mark it delivered on this page; the creator confirms receipt.</small>
    </fieldset>
  </div>;
}
