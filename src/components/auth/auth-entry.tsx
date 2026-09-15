import { localAuthEnabled } from '@/lib/auth';
import { verifiedNotice } from '@/lib/notices';
import type { Query } from '@/components/page-props';
import { AuthDialog, type TestAccount } from './auth-dialog';

/** Seeded local personas for manual QA. `/api/dev/session` refuses them outside loopback development. */
const TEST_ACCOUNTS: TestAccount[] = [
  { persona: 'creator_d', name: 'Minh Le', role: 'New creator, no services yet', returnTo: '/creator/services' },
  { persona: 'creator_c', name: 'Ari Nguyen', role: 'Creator with many test services and orders', returnTo: '/creator/services' },
  { persona: 'buyer_a', name: 'Sam Tran', role: 'Buyer', returnTo: '/explore' },
  { persona: 'buyer_b', name: 'Linh Pham', role: 'Second buyer (bids, competing checkouts)', returnTo: '/explore' },
  { persona: 'admin', name: 'Local Admin', role: 'Admin console', returnTo: '/admin' },
  { persona: 'finance', name: 'Finance Operator', role: 'Refunds, cases, operations', returnTo: '/admin' },
  { persona: 'moderator', name: 'Mod Operator', role: 'Samples and disputes', returnTo: '/admin' },
];

const text = (query: Query, key: string) => (typeof query[key] === 'string' ? (query[key] as string) : '');
const safePath = (value: string) => (value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard');

/** Server wrapper shared by the intercepted dialog and the direct /sign-in and /sign-up pages. */
export function AuthEntry({ mode, variant, query }: { mode: 'signin' | 'signup'; variant: 'modal' | 'page'; query: Query }) {
  const showTestAccounts = localAuthEnabled() && process.env.DEV_SESSIONS !== 'off';
  return <AuthDialog
    mode={mode}
    variant={variant}
    returnTo={safePath(text(query, 'return_to'))}
    defaultRole={text(query, 'role') === 'creator' ? 'creator' : 'buyer'}
    initialError={verifiedNotice(query, 'error')}
    initialMessage={verifiedNotice(query, 'message')}
    testAccounts={showTestAccounts ? TEST_ACCOUNTS : []}
  />;
}
