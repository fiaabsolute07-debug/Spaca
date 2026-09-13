import { CommandError, text, type CommandHandler } from '@/lib/commands';
import { assertFlags } from '@/modules/admin/policy';

const createPool: CommandHandler = async ({ tx, actor, form }) => {
  await assertFlags(tx, ['TOKEN_REWARDS_ENABLED']);
  const requestId = text(form, 'request_id', false) || null;
  const symbol = text(form, 'asset_symbol');
  const atomic = text(form, 'amount');
  if (!/^[A-Z0-9]{2,12}$/.test(symbol) || !/^[0-9]+$/.test(atomic)) throw new CommandError('Reward pool asset and amount are invalid');
  await tx`insert into app.reward_pools (request_id,asset_symbol,amount_atomic,created_by) values (${requestId},${symbol},${atomic},${actor.id})`;
  return { path: requestId ? `/requests/${requestId}` : '/dashboard', message: 'Reward pool recorded as local simulation only' };
};

export const rewardCommands: Record<string, CommandHandler> = { create_pool: createPool };
