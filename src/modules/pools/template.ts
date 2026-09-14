/**
 * Reward template validation (master §11.6). One required CASH item on a USD-pegged asset defines the per-hire
 * order price; TOKEN items carry chain/contract/decimals/atomic amount and never a USD value; PERK items describe
 * a fulfillment method and deadline. Optional items are marked before any creator accepts.
 */
import { CommandError, UUID_PATTERN, type Row, type Tx } from '@/lib/commands';
import { isFlagEnabled } from '@/modules/admin/policy';
import { atomicToUsdMinor, parseDecimalToAtomic } from '@/modules/crypto/registry';

export type MoneyItem = { key: string; kind: 'CASH' | 'TOKEN'; required: boolean; asset_id: string; symbol: string; decimals: number; amount_atomic: string };
export type PerkItem = { key: string; kind: 'PERK'; required: boolean; perk_type: 'WHITELIST' | 'ACCESS' | 'COMMUNITY_ROLE' | 'NFT'; description: string; fulfillment_method: string; deadline_days: number };
export type TemplateItem = MoneyItem | PerkItem;
export type Template = { items: TemplateItem[]; cashItem: MoneyItem; cashMinor: bigint };

const PERK_TYPES = ['WHITELIST', 'ACCESS', 'COMMUNITY_ROLE', 'NFT'] as const;

function fail(message: string): never {
  throw new CommandError(`Reward template: ${message}`);
}

export async function validateTemplate(tx: Tx, chainId: number, raw: unknown): Promise<Template> {
  let input: unknown = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch {
      fail('items must be a JSON array');
    }
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) fail('between 1 and 10 items are required');
  const keys = new Set<string>();
  const items: TemplateItem[] = [];
  for (const entry of input as Record<string, unknown>[]) {
    const key = String(entry?.key ?? '');
    if (!/^[a-z0-9_-]{1,40}$/.test(key) || keys.has(key)) fail(`item keys must be unique lowercase identifiers (${key || 'missing'})`);
    keys.add(key);
    const required = entry.required !== false;
    const kind = String(entry.kind ?? '');
    if (kind === 'CASH' || kind === 'TOKEN') {
      const assetId = String(entry.asset_id ?? '');
      const [asset] = UUID_PATTERN.test(assetId) ? await tx<Row[]>`select * from app.chain_assets where id=${assetId} and chain_id=${chainId}` : [];
      if (!asset || !asset.allowlisted) fail(`${key}: asset must be allowlisted on the pool network`);
      let amount: bigint;
      try {
        amount = parseDecimalToAtomic(String(entry.amount ?? ''), Number(asset.decimals));
      } catch (error) {
        fail(`${key}: ${error instanceof Error ? error.message : 'invalid amount'}`);
      }
      if (amount <= 0n) fail(`${key}: amount must be positive`);
      if (kind === 'CASH' && !asset.usd_pegged) fail(`${key}: CASH needs a USD-pegged asset`);
      if (kind === 'TOKEN' && !(await isFlagEnabled(tx, 'TOKEN_REWARDS_ENABLED'))) throw new CommandError('Token rewards are disabled', 'FEATURE_DISABLED');
      items.push({ key, kind, required, asset_id: String(asset.id), symbol: String(asset.symbol), decimals: Number(asset.decimals), amount_atomic: amount.toString() });
    } else if (kind === 'PERK') {
      const perkType = String(entry.perk_type ?? '') as PerkItem['perk_type'];
      if (!PERK_TYPES.includes(perkType)) fail(`${key}: perk_type must be one of ${PERK_TYPES.join(', ')}`);
      if (perkType === 'NFT' && !(await isFlagEnabled(tx, 'NFT_REWARDS_ENABLED'))) throw new CommandError('NFT rewards are disabled', 'FEATURE_DISABLED');
      const description = String(entry.description ?? '').trim();
      const method = String(entry.fulfillment_method ?? '').trim();
      const days = Number(entry.deadline_days);
      if (description.length < 10 || method.length < 5) fail(`${key}: describe the perk and how it is fulfilled`);
      if (!Number.isInteger(days) || days < 1 || days > 180) fail(`${key}: deadline_days must be 1..180`);
      items.push({ key, kind: 'PERK', required, perk_type: perkType, description: description.slice(0, 500), fulfillment_method: method.slice(0, 200), deadline_days: days });
    } else {
      fail(`${key}: kind must be CASH, TOKEN or PERK`);
    }
  }
  const cash = items.filter((item): item is MoneyItem => item.kind === 'CASH');
  if (cash.length !== 1 || !cash[0]!.required) fail('exactly one required CASH item defines the per-hire price');
  const cashMinor = atomicToUsdMinor(BigInt(cash[0]!.amount_atomic), cash[0]!.decimals);
  if (cashMinor === null || cashMinor <= 0n) fail('the CASH amount must be a whole number of cents');
  return { items, cashItem: cash[0]!, cashMinor };
}

export function moneyItems(items: TemplateItem[]): MoneyItem[] {
  return items.filter((item): item is MoneyItem => item.kind !== 'PERK');
}

export function cashMinorOf(items: TemplateItem[]): bigint {
  const cash = moneyItems(items).find((item) => item.kind === 'CASH')!;
  return atomicToUsdMinor(BigInt(cash.amount_atomic), cash.decimals)!;
}
