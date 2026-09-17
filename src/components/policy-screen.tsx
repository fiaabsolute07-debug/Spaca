import Link from 'next/link';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { Query } from '@/components/page-props';
import { appStage } from '@/lib/environment';

export type PolicyRoute = '/terms' | '/privacy' | '/refund-policy' | '/support' | '/reset-password';
export function PolicyScreen({
  route,
  query
}: {
  route: PolicyRoute;
  query: Query;
}) {
  const notices = <Notices query={query} />;
  const local = appStage() === 'local';
  return <main className="container">
    <PageHeading
      eyebrow={local ? 'Local sandbox information' : 'Early access'}
      title={
        route === '/support' ? 'How can we help?'
          : route === '/privacy' ? 'Your project stays yours.'
          : route === '/refund-policy' ? 'Refunds & revisions'
          : route === '/reset-password' ? 'Account recovery'
          : 'Working together on spaca'
      }
    />
    <div className="panel">
      {notices}
      {route === '/support' ? <>
        <h2>Get help with an order</h2>
        <p>
          Open your order workspace to send a message or raise a dispute.{local ? ' This local environment has no external support inbox and sends no email.' : ''}
        </p>
        <Link className="button button-dark" href="/dashboard">Open your workspace</Link>
      </> : route === '/reset-password' ? <p>
        {local
          ? 'Email recovery requires a configured authentication email provider. It is not enabled in this local sandbox. Use a separate test account to continue local acceptance testing.'
          : 'Password recovery by email is not available yet. Continue with X or Google, which sign in to the same account.'}
      </p> : <>
        <p>
          {local
            ? 'This environment is for local product testing. These are product operating rules, not reviewed production legal terms.'
            : 'spaca is in early access and payments are not open. These are the product’s operating rules while the full terms are prepared.'}
        </p>
        <h3>Clear scope and disclosed fees</h3>
        <p>
          Review the service scope, delivery period, included revisions, and amount
          before booking. Any platform fee is shown before you pay. Third-party payment costs are
          separate and must be disclosed before any live transaction.
        </p>
        <h3>Delivery, review, and refunds</h3>
        <p>
          Buyer and creator work inside the order workspace. Buyers may request an
          included revision, approve submitted work, or raise a dispute. Refunds follow
          authorized order transitions; a cancellation is not proof of a completed
          refund.
        </p>
        <h3>Privacy</h3>
        <p>
          Private briefs, messages, and deliveries are visible only to authorized order
          participants and scoped support roles. Public services and profile samples are
          visible to visitors. Do not use real confidential or payment data in local
          tests.
        </p>
        <div className="notice">
          Production launch is blocked until final policies, support contact, privacy
          controls, and payment capabilities are reviewed and configured.
        </div>
      </>}
    </div>
  </main>;
}
