import type { Metadata } from 'next';
import Link from 'next/link';
import Script from 'next/script';
import { Archivo, Geist, Geist_Mono } from 'next/font/google';
import { getActor } from '@/lib/auth';
import { appStage, paymentsOpen } from '@/lib/environment';
import { SiteChrome } from '@/components/site-chrome';
import { HeaderNav } from '@/components/header-nav';
import { AccountMenu, WorkspaceBack } from '@/components/account-menu';
import { FundMenu } from '@/components/fund-menu';
import { NotificationMenu } from '@/components/notifications/notification-menu';
import { unreadCount } from '@/modules/notifications/inbox';
import { accountTypeOf, homePath } from '@/lib/account';
import { getAccountSummary } from '@/lib/read-model';
import { SpacaLockup } from '@/components/brand/spaca-logo';
import { themeBootScript } from '@/components/landing/theme-boot';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

// Three faces, one job each (docs/brand/spaca-brand-kit.html): Archivo condensed for headlines and big numbers,
// Geist for everything you read, Geist Mono for labels, buttons, table figures, hashes and wallet addresses.
const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  // Tab title in the marketplace pattern "brand | what it is | what you get" (2026-09-16, modelled on Fiverr's).
  // A page that sets its own title reads "Page | spaca".
  title: { default: 'spaca | Creator campaigns marketplace for web3 launches | Hire crypto-native creators on X', template: '%s | spaca' },
  description: 'Hire crypto-native researchers, writers and KOLs on X from one brief. Each creator is paid when their work is approved.',
};

// The shell reads the current session and therefore must stay request-time
// rendered. This also keeps `next build` from trying to contact a local or
// production database while collecting static metadata.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children, auth, dialog }: { children: React.ReactNode; auth: React.ReactNode; dialog: React.ReactNode }) {
  const actor = await getActor();
  const [account, unread] = actor ? await Promise.all([getAccountSummary(actor), unreadCount(actor.id)]) : [null, 0];
  // The strip above the header says what kind of place this is: the local sandbox, staging, or early access without payments.
  const stage = appStage();
  // Vercel Analytics counts page views on the deployments only. Local development is not an audience, and a
  // beacon from a developer's machine would be noise in the numbers the owner reads.

  const banner = stage === 'local'
    ? <div className="sandbox-banner"><span className="live-dot" /> <strong>Local sandbox</strong> Test accounts and simulated payments. No real funds move.</div>
    : stage === 'staging'
      ? <div className="sandbox-banner"><span className="live-dot" /> <strong>Staging</strong> Test data only. No real funds move.</div>
      : !paymentsOpen()
        ? <div className="sandbox-banner"><span className="live-dot" /> <strong>Early access</strong> Payments are not open yet. Set up, post and apply now.</div>
        : null;
  const header = <>
    {banner}
    <div className="header-shell">
      <header className="header">
        <Link href={homePath(Boolean(actor))} className="wordmark" aria-label="spaca home"><SpacaLockup size={26} /></Link>
        <HeaderNav type={actor ? accountTypeOf(actor) : null} />
        <form className="header-search" action="/explore" method="get" role="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input name="q" type="search" placeholder="Search creators and services" aria-label="Search creators and services" />
        </form>
        <div className="header-actions">
          {actor
            ? <><NotificationMenu initialUnread={unread} /><FundMenu type={accountTypeOf(actor)} /><AccountMenu type={accountTypeOf(actor)} account={account!} /></>
            : <><Link href="/sign-in" className="login-link" scroll={false}>Log in</Link><Link href="/sign-up" className="button button-dark compact" scroll={false}>Get started</Link></>}
        </div>
      </header>
    </div>
  </>;
  const footer = <footer className="site-footer">
    <div className="site-footer-inner">
      <div>
        <Link href={homePath(Boolean(actor))} aria-label="spaca home"><SpacaLockup size={22} /></Link>
        <p>Creator campaigns on X for web3 and AI launches.</p>
      </div>
      <nav className="site-footer-links" aria-label="Footer">
        <Link href="/explore">Explore</Link><Link href="/requests">Campaigns</Link><Link href="/support">Support</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/refund-policy">Refund policy</Link>
      </nav>
      <small>{stage === 'local' ? 'Local development environment · All displayed transactions are test activity.'
        : stage === 'staging' ? 'Staging · Test data only.'
        : !paymentsOpen() ? 'Early access · Payments are not open yet.' : `© ${new Date().getUTCFullYear()} spaca`}</small>
    </div>
  </footer>;
  const type = actor ? accountTypeOf(actor) : null;
  const back = actor ? <WorkspaceBack type={type} /> : null;
  // suppressHydrationWarning: the landing theme boot script may set data-landing-theme on <html> before hydration.
  return <html lang="en" className={`${archivo.variable} ${geist.variable} ${geistMono.variable}`} suppressHydrationWarning><body><Script id="landing-theme" strategy="beforeInteractive">{themeBootScript}</Script><SiteChrome header={header} footer={footer} back={back}>{children}</SiteChrome>{auth}{dialog}{stage === 'local' ? null : <Analytics />}</body></html>;
}
