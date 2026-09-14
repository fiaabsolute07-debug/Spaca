import { CommandError, type CommandHandler } from '@/lib/commands';

/** The v1 reward-pool simulation is retired; funded campaign pools live in src/modules/pools (W5-C2). */
const createPool: CommandHandler = async () => {
  throw new CommandError('create_pool was replaced by create_campaign_pool (funded, per-asset campaign pools)', 'DOMAIN_RULE');
};

export const rewardCommands: Record<string, CommandHandler> = { create_pool: createPool };
