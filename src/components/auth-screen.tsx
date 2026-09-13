import Link from 'next/link';
import { Field, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import type { Query } from '@/components/page-props';

export function AuthScreen({
  signup,
  query
}: {
  signup: boolean;
  query: Query;
}) {
  const notices = <Notices query={query} />;
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
        {signup ? 'Create your account' : 'Log in to Capacity'}
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
        {signup && <Field name="role" label="What brings you here?">
          <select name="role" defaultValue={str(query.role, 'buyer')}>
            <option value="buyer">I want to hire creators</option>
            <option value="creator">I want to offer my skills</option>
          </select>
        </Field>}
        <button className="button button-dark">
          {signup ? 'Create account' : 'Log in'}
          {" ↗"}
        </button>
      </form>
      <p className="muted">
        {signup ? 'Already have an account?' : 'New around here?'}
        {" "}
        <Link className="text-link" href={signup ? '/sign-in' : '/sign-up'}>
          {signup ? 'Log in' : 'Create an account'}
        </Link>
      </p>
    </div>
  </main>;
}
