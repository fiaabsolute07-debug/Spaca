import Link from 'next/link';
import { SelectField } from './select';
import { Field, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import type { Query } from '@/components/page-props';
import { localAuthEnabled } from '@/lib/auth';

/** Seeded local personas for manual QA. `/api/dev/session` refuses them outside loopback development. */
const TEST_ACCOUNTS = [
  { persona: 'creator_d', name: 'Minh Le', role: 'New creator, no services yet', returnTo: '/creator/services' },
  { persona: 'creator_c', name: 'Ari Nguyen', role: 'Creator with many test services and orders', returnTo: '/creator/services' },
  { persona: 'buyer_a', name: 'Sam Tran', role: 'Buyer', returnTo: '/explore' },
  { persona: 'buyer_b', name: 'Linh Pham', role: 'Second buyer (bids, competing checkouts)', returnTo: '/explore' },
  { persona: 'admin', name: 'Local Admin', role: 'Admin console', returnTo: '/admin' },
  { persona: 'finance', name: 'Finance Operator', role: 'Refunds, cases, operations', returnTo: '/admin' },
  { persona: 'moderator', name: 'Mod Operator', role: 'Samples and disputes', returnTo: '/admin' },
] as const;

export function AuthScreen({
  signup,
  query
}: {
  signup: boolean;
  query: Query;
}) {
  const notices = <Notices query={query} />;
  const showTestAccounts = !signup && localAuthEnabled() && process.env.DEV_SESSIONS !== 'off';
  return <main className="auth-layout">
    <div>
      <div className="eyebrow">A little less friction. A lot more possibility.</div>
      <h1>
        {signup ? 'Good work starts with a hello.' : 'Welcome back to your next idea.'}
      </h1>
      <p>
        One account to hire creative people, offer your skills, and keep your projects
        moving.
      </p>
      <div className="fee-note">
        This is a local sandbox. Create a test account using an email and password. No
        email is sent and no real payments are processed.
      </div>
    </div>
    <div className="panel">
      {notices}
      <h2>
        {signup ? 'Create your account' : 'Log in to spaca'}
      </h2>
      <form action="/api/auth" method="post">
        <input type="hidden" name="action" value={signup ? 'signup' : 'login'} />
        <input
          type="hidden"
          name="return_to"
          value={typeof query.return_to === 'string' ? query.return_to : '/dashboard'}
        />
        {signup && <Field name="display_name" label="Your name" required />}
        <Field name="email" type="email" label="Email address" required />
        <Field name="password" type="password" label="Password (minimum 12 characters)" required />
        {signup && <SelectField name="role" label="What brings you here?" defaultValue={str(query.role) === 'creator' ? 'creator' : 'buyer'}
          options={[{ value: 'buyer', label: 'I want to hire creators' }, { value: 'creator', label: 'I want to offer my skills' }]} />}
        <button className="button button-dark">
          {signup ? 'Create account' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        {signup ? 'Already have an account?' : 'New around here?'}
        {" "}
        <Link className="text-link" href={signup ? '/sign-in' : '/sign-up'}>
          {signup ? 'Log in' : 'Create an account'}
        </Link>
      </p>
      {showTestAccounts && <section className="test-accounts" aria-labelledby="test-accounts-heading">
        <h3 id="test-accounts-heading">Test accounts</h3>
        <p className="muted">Local sandbox only. One click signs you in; no password.</p>
        <ul>
          {TEST_ACCOUNTS.map((account) => <li key={account.persona}>
            <form action="/api/dev/session" method="post">
              <input type="hidden" name="persona" value={account.persona} />
              <input type="hidden" name="return_to" value={typeof query.return_to === 'string' ? query.return_to : account.returnTo} />
              <button className="test-account" type="submit">
                <strong>{account.name}</strong>
                <span>{account.role}</span>
              </button>
            </form>
          </li>)}
        </ul>
      </section>}
    </div>
  </main>;
}
