/** Social account commands (XPL-01). Links are always self-reported; there is no verification flow yet. */
import { CommandError, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { canonicalizeSocialAccount, isSocialPlatform } from '.';

const addSocialAccount: CommandHandler = async ({ tx, actor, form }) => {
  const platform = text(form, 'platform');
  if (!isSocialPlatform(platform)) throw new CommandError('Unsupported platform');
  const { handle, canonicalUrl } = canonicalizeSocialAccount(platform, text(form, 'account', true, 500));
  const [live] = await tx<Row[]>`select creator_id from app.social_accounts where platform=${platform} and lower(canonical_url)=lower(${canonicalUrl}) and removed_at is null`;
  if (live) {
    throw new CommandError(String(live.creator_id) === actor.id ? 'You already linked this account' : 'Another creator already listed this account. Contact support if it is yours.', 'ORDER_STATE_CONFLICT');
  }
  const [count] = await tx<Row[]>`select count(*)::int as n from app.social_accounts where creator_id=${actor.id} and removed_at is null`;
  if (Number(count!.n) >= 10) throw new CommandError('You can link up to 10 accounts');
  const [account] = await tx<Row[]>`insert into app.social_accounts (creator_id,platform,handle,canonical_url) values (${actor.id},${platform},${handle},${canonicalUrl}) returning id`;
  return { path: '/settings/profile', message: 'Account linked. It shows as self-reported on your profile.', id: String(account!.id) };
};

/** Sold orders keep their channel snapshot; a channel still used by a live PUBLISH listing cannot be removed. */
const removeSocialAccount: CommandHandler = async ({ tx, actor, form }) => {
  const accountId = uuid(form, 'account_id');
  const [account] = await tx<Row[]>`select id from app.social_accounts where id=${accountId} and creator_id=${actor.id} and removed_at is null for update`;
  if (!account) throw new CommandError('Account not found', 'NOT_FOUND');
  const [inUse] = await tx<Row[]>`select title from app.services where publish_account_id=${accountId} and status in ('PUBLISHED','PAUSED') limit 1`;
  if (inUse) throw new CommandError(`"${String(inUse.title)}" posts on this account. Archive that service or change its channel first.`, 'ORDER_STATE_CONFLICT');
  await tx`update app.services set publish_account_id=null,version=version+1,updated_at=now() where publish_account_id=${accountId} and status='DRAFT'`;
  await tx`update app.social_accounts set removed_at=now(),updated_at=now() where id=${accountId}`;
  return { path: '/settings/profile', message: 'Account removed' };
};

export const publishCommands: Record<string, CommandHandler> = {
  add_social_account: addSocialAccount,
  remove_social_account: removeSocialAccount,
};
