/** Command registry: one handler per command name, merged from domain modules. */
import type { CommandHandler } from '@/lib/commands';
import { accessCommands } from '@/modules/access/commands';
import { adminCommands } from '@/modules/admin/commands';
import { auctionCommands } from '@/modules/auctions/commands';
import { catalogCommands } from '@/modules/catalog/commands';
import { cryptoCommands } from '@/modules/crypto/commands';
import { moderationCommands } from '@/modules/moderation/commands';
import { orderCommands } from '@/modules/orders/commands';
import { poolCommands } from '@/modules/pools/commands';
import { publishCommands } from '@/modules/publish/commands';
import { requestCommands } from '@/modules/requests/commands';
import { rewardCommands } from '@/modules/rewards/commands';

const modules = [catalogCommands, orderCommands, requestCommands, auctionCommands, rewardCommands, cryptoCommands, poolCommands, publishCommands, moderationCommands, accessCommands, adminCommands];

export const commandHandlers: Readonly<Record<string, CommandHandler>> = (() => {
  const merged: Record<string, CommandHandler> = {};
  for (const handlers of modules) {
    for (const [name, handler] of Object.entries(handlers)) {
      if (merged[name]) throw new Error(`duplicate command handler: ${name}`);
      merged[name] = handler;
    }
  }
  return Object.freeze(merged);
})();
