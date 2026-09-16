import type { Metadata } from 'next';
import Link from 'next/link';
import Script from 'next/script';
import { getActor } from '@/lib/auth';
import { SiteChrome } from '@/components/site-chrome';
import { HeaderNav } from '@/components/header-nav';
import { AccountMenu, WorkspaceBack } from '@/components/account-menu';
import { accountTypeOf } from '@/lib/account';
import { SpacaLockup } from '@/components/brand/spaca-logo';
import { themeBootScript } from '@/components/landing/theme-boot';
import './globals.css';

export const metadata: Metadata = {
  title: 'spaca — Creator campaigns for web3 launches',
  description: 'Hire crypto-native researchers, writers and KOLs on X from one brief. Each creator is paid when their work is approved.',
};

// The shell reads the current session and therefore must stay request-time
// rendered. This also keeps `next build` from trying to contact a local or
// production database while collecting static metadata.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  const actor = await getActor();
  const header = <>
    <div className="sandbox-banner"><span className="live-dot" /> <strong>Local sandbox</strong> Test accounts and simulated payments. No real funds move.</div>
    <div className="header-shell">
      <header className="header">
        <Link href="/" className="wordmark" aria-label="spaca home"><SpacaLockup size={26} /></Link>
        <HeaderNav type={actor ? accountTypeOf(actor) : null} />
        <form className="header-search" action="/explore" method="get" role="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input name="q" type="search" placeholder="Search creators and services" aria-label="Search creators and services" />
        </form>
        <div className="header-actions">
          {actor
            ? <AccountMenu type={accountTypeOf(actor)} />
            : <><Link href="/sign-in" className="login-link" scroll={false}>Log in</Link><Link href="/sign-up" className="button compact" scroll={false}>Get started</Link></>}
        </div>
      </header>
    </div>
  </>;
  const footer = <footer className="site-footer">
    <div className="site-footer-inner">
      <div>
        <Link href="/" aria-label="spaca home"><SpacaLockup size={22} /></Link>
        <p>Creator campaigns on X for web3 and AI launches.</p>
      </div>
      <nav className="site-footer-links" aria-label="Footer">
        <Link href="/explore">Explore</Link><Link href="/requests">Campaigns</Link><Link href="/support">Support</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/refund-policy">Refund policy</Link>
      </nav>
      <small>Local development environment · All displayed transactions are test activity.</small>
    </div>
  </footer>;
  const type = actor ? accountTypeOf(actor) : null;
  const back = actor ? <WorkspaceBack type={type} /> : null;
  // suppressHydrationWarning: the landing theme boot script may set data-landing-theme on <html> before hydration.
  return <html lang="en" suppressHydrationWarning><body><Script id="landing-theme" strategy="beforeInteractive">{themeBootScript}</Script><SiteChrome header={header} footer={footer} back={back}>{children}</SiteChrome>{auth}</body></html>;
}
