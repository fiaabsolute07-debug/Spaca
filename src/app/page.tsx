import { existsSync } from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { SpacaLockup } from '@/components/brand/spaca-logo';
import { HeroSearch } from '@/components/landing/hero-search';
import { GoalStrip } from '@/components/landing/goal-strip';
import { AuctionsStrip, CreatorsAvailable, PopularServices } from '@/components/landing/showcase';
import { getLandingShowcase, getOpenGoalCounts } from '@/lib/read-model';
import { getActor } from '@/lib/auth';
import { homePath } from '@/lib/account';
import { ThemeToggle } from '@/components/landing/theme-toggle';
import styles from '@/components/landing/landing.module.css';

export const dynamic = 'force-dynamic';

// Muted, video-only hero (no audio track, index at the start of the file) with a ~30 KB poster that paints first.
// The browser downloads only the first source it can play: HEVC where supported (about a third smaller), H.264
// otherwise; screens up to 640px get 640×360, wider ones 854×480. Codec strings match the encoded files.
const HERO_VIDEO = '/landing/hero.mp4';
const HERO_POSTER = '/landing/hero-poster.jpg';
const HERO_SOURCES = [
  { src: '/landing/hero-640.hevc.mp4', type: 'video/mp4; codecs="hvc1.1.6.L63.B0"', media: '(max-width: 640px)' },
  { src: '/landing/hero-640.mp4', type: 'video/mp4; codecs="avc1.64001E"', media: '(max-width: 640px)' },
  { src: '/landing/hero.hevc.mp4', type: 'video/mp4; codecs="hvc1.1.6.L90.B0"' },
  { src: HERO_VIDEO, type: 'video/mp4; codecs="avc1.64001F"' },
];

const FAQ = [
  { q: 'How do I pay?', a: 'By card at launch. USDC and token reward pools are on testnet and not live yet. You never need a wallet to hire.' },
  { q: 'When does a creator get paid?', a: 'When you approve their delivery, or when the review window you agreed to at checkout closes without a revision request or dispute.' },
  { q: "What if the work isn't right?", a: 'Every order includes one revision. If it still misses the agreed scope, open a dispute and payout pauses while a person reviews it.' },
  { q: 'What are the fees?', a: "The price on a service is what you agree with the creator, and it is shown before you book. spaca's own fee is not set yet — it is published before payments open, and nothing can be bought until then." },
  { q: 'What is an auction for?', a: 'A whitelist spot, a guaranteed mint or a pre-market allocation, sold to the highest bid. The seller locks collateral before the listing opens, your payment waits in escrow, and you get it back with the collateral if nothing is delivered.' },
  { q: 'Do creators connect their X account?', a: 'Only if they choose to. Connecting reads their public X profile once, so buyers see their photo and follower count; the access token is revoked immediately and spaca never posts for them.' },
  { q: 'How do I become a creator?', a: 'Apply with your X handle, the topics you cover and a few work samples. We are onboarding a small group of founding creators first.' },
];

const FOOTER_COLUMNS = [
  { title: 'Product', links: [{ label: 'Services', href: '#services' }, { label: 'Campaign tabs', href: '/campaigns' }, { label: 'Auctions', href: '/auctions' }, { label: 'Explore creators', href: '/explore' }] },
  { title: 'Creators', links: [{ label: 'Apply as a creator', href: '/sign-up?role=creator' }, { label: 'Guidelines', href: '/terms' }] },
  { title: 'Company', links: [{ label: 'Contact', href: '/support' }, { label: 'Questions', href: '#faq' }] },
  { title: 'Legal', links: [{ label: 'Terms', href: '/terms' }, { label: 'Privacy', href: '/privacy' }, { label: 'Refund policy', href: '/refund-policy' }] },
];

export default async function LandingPage() {
  const hasVideo = existsSync(path.join(process.cwd(), 'public', HERO_VIDEO));
  const [goalCounts, showcase, actor] = await Promise.all([getOpenGoalCounts(), getLandingShowcase(), getActor()]);
  const home = homePath(Boolean(actor));
  // The services and creators strips render nothing when there is no real work to show, and an empty database is what a
  // fresh deployment has. A link to a section that is not on the page does nothing when clicked, so the links go with it.
  const sections = { services: showcase.services.length > 0, creators: showcase.creators.length > 0 };
  const footerColumns = FOOTER_COLUMNS.map((column) => ({ ...column, links: column.links.filter((link) => link.href !== '#services' || sections.services) }));

  return <div className={styles.page} id="top">
    <header className={styles.nav}>
      <div className={styles.navInner}>
        <Link href={home} className={styles.brand} aria-label="spaca home"><SpacaLockup size={26} /></Link>
        <nav className={styles.navLinks} aria-label="Landing sections">
          {sections.services && <a href="#services">Services</a>}
          {sections.creators && <a href="#creators">Creators</a>}
          <a href="#auctions">Auctions</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className={styles.navActions}>
          <ThemeToggle />
          <Link href="/sign-up?role=creator" className={styles.navLink}>Apply as a creator</Link>
          <Link href="/sign-up?role=buyer" className={styles.navCta}>Early access</Link>
        </div>
      </div>
    </header>

    <main>
      <section className={styles.hero}>
        <div className={styles.heroMedia} aria-hidden style={hasVideo ? { backgroundImage: `url(${HERO_POSTER})` } : undefined}>
          {hasVideo
            ? <video className={styles.heroVideo} poster={HERO_POSTER} autoPlay muted loop playsInline preload="auto" disablePictureInPicture>
                {HERO_SOURCES.map((source) => <source key={source.src} src={source.src} type={source.type} media={source.media} />)}
              </video>
            : <span className={styles.videoPlaceholder}>Background video goes here — add public{HERO_VIDEO}</span>}
          <div className={styles.heroScrim} />
        </div>
        <div className={`${styles.heroContent} ${styles.heroCenter}`}>
          <p className={styles.heroKicker}>Creator campaigns for web3 launches, on X.</p>
          <h1 className={styles.heroHeadline}>Find the voices your launch needs.</h1>
          <HeroSearch />
        </div>
      </section>

      <section className={styles.goalsSection} aria-labelledby="goals-heading">
        <div className={styles.containerWide}>
          <div className={styles.goalsHead}>
            <div><p className={styles.kicker}>Campaigns</p><h2 id="goals-heading" className={styles.h2Flush}>Pick what your launch needs.</h2></div>
            <Link className={styles.more} href="/campaigns">All campaign tabs ›</Link>
          </div>
          <GoalStrip counts={goalCounts} />
        </div>
      </section>

      <PopularServices services={showcase.services} label={showcase.services_label} />
      <CreatorsAvailable creators={showcase.creators} />
      <AuctionsStrip auctions={showcase.auctions} serverNow={showcase.server_now} />

      <section id="faq" className={styles.section}>
        <div className={styles.container}>
          <h2 className={styles.h2}>Questions.</h2>
          <div className={styles.faq}>
            {FAQ.map((item, index) => <details key={item.q} open={index === 0}>
              <summary><span>{item.q}</span><span className={styles.faqIcon} aria-hidden /></summary>
              <p className={styles.body}>{item.a}</p>
            </details>)}
          </div>
        </div>
      </section>

      <section className={styles.finalCta}>
        <h2 className={styles.h2Large}>Your next launch deserves better than a group chat.</h2>
        <p className={styles.lead}>Say what you are launching and what you need. Creators apply with their own price, and you pick.</p>
        <div className={styles.ctaRow}>
          <Link className={styles.buttonPrimary} href="/sign-up?role=buyer">Post your first brief</Link>
          <Link className={styles.buttonOutline} href="/sign-up?role=creator">Apply as a creator</Link>
        </div>
      </section>
    </main>

    <footer className={styles.footer}>
      <div className={styles.containerWide}>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <Link href={home} aria-label="spaca home" className={styles.brand}><SpacaLockup size={26} /></Link>
            <p>Creator campaigns for web3 launches, on X. Each creator is paid when their work is approved.</p>
            <span className={styles.footerTag}><span aria-hidden>{'{'}</span> Local build · testnet only <span aria-hidden>{'}'}</span></span>
          </div>
          {footerColumns.map((column) => <nav key={column.title} className={styles.footerCol} aria-label={column.title}>
            <span className={styles.footerHead}>{column.title}</span>
            {column.links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>)}
        </div>
        <p className={styles.footnote}>Reward pools and crypto payments run on testnet and hold no real funds. Fees are published before launch.</p>
        <div className={styles.footerBottom}>
          <span>© {new Date().getFullYear()} spaca</span>
          <a href="#top">Back to top ↑</a>
        </div>
      </div>
    </footer>
  </div>;
}
