import { existsSync } from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { SpacaLockup } from '@/components/brand/spaca-logo';
import { HeroSearch } from '@/components/landing/hero-search';
import { GoalStrip } from '@/components/landing/goal-strip';
import { LaunchStack } from '@/components/landing/launch-stack';
import { PoolFlow } from '@/components/landing/pool-flow';
import { getOpenGoalCounts } from '@/lib/read-model';
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
  { q: 'What are the fees?', a: 'Fees are shown before you pay. [FEE POLICY — published before launch]' },
  { q: 'Do creators connect their X account?', a: 'No. Creators share links to their work; we never ask for access to their account.' },
  { q: 'How do I become a creator?', a: 'Apply with your X handle, the topics you cover and a few work samples. We are onboarding a small group of founding creators first.' },
];

const FOOTER_COLUMNS = [
  { title: 'Product', links: [{ label: 'How it works', href: '#how' }, { label: 'Campaign tabs', href: '/campaigns' }, { label: 'Reward pools', href: '#pools' }, { label: 'Explore creators', href: '/explore' }] },
  { title: 'Creators', links: [{ label: 'Apply as a creator', href: '/sign-up?role=creator' }, { label: 'Guidelines', href: '/terms' }] },
  { title: 'Company', links: [{ label: 'Contact', href: '/support' }, { label: 'AI and SaaS', href: '#ai' }] },
  { title: 'Legal', links: [{ label: 'Terms', href: '/terms' }, { label: 'Privacy', href: '/privacy' }, { label: 'Refund policy', href: '/refund-policy' }] },
];

/** Honest facts in the spot where marketplaces put client logos: spaca has no clients to show yet. */
const HERO_FACTS = [
  { label: 'Paid on approval', tone: 'green' },
  { label: 'Sponsored posts disclosed', tone: 'plain' },
  { label: 'No wallet needed to hire', tone: 'plain' },
  { label: 'Reward pools on testnet', tone: 'orange' },
];

export default async function LandingPage() {
  const hasVideo = existsSync(path.join(process.cwd(), 'public', HERO_VIDEO));
  const goalCounts = await getOpenGoalCounts();

  return <div className={styles.page} id="top">
    <header className={styles.nav}>
      <div className={styles.navInner}>
        <Link href="/" className={styles.brand} aria-label="spaca home"><SpacaLockup size={26} /></Link>
        <nav className={styles.navLinks} aria-label="Landing sections">
          <a href="#how">How it works</a>
          <a href="#pools">Reward pools</a>
          <a href="#creators">For creators</a>
          <a href="#ai">AI &amp; SaaS</a>
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
        <ul className={styles.heroFacts} aria-label="How spaca works">
          {HERO_FACTS.map((fact) => <li key={fact.label} data-tone={fact.tone}>{fact.label}</li>)}
        </ul>
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

      <section className={styles.band}>
        <div className={styles.container}>
          <h2 className={styles.h2}>Why spaca.</h2>
          <div className={styles.grid2}>
            <article className={styles.cardOnBand}><p className={styles.eyebrow}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>Creators</p><h3 className={styles.h3}>Crypto-native creators only.</h3><p className={styles.body}>Researchers, analysts and writers on X, chosen for their work samples and delivery record rather than follower count.</p></article>
            <article className={styles.cardOnBand}><p className={styles.eyebrow}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a6 6 0 0 1 12 0M15 20a5 5 0 0 1 7-4.5" /></svg>Campaigns</p><h3 className={styles.h3}>A whole team from one brief.</h3><p className={styles.body}>Post once, compare applicants and hire several. Each creator gets a separate order you can track.</p></article>
            <article className={styles.cardOnBand}><p className={styles.eyebrow}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>Payouts</p><h3 className={styles.h3}>Paid on approval.</h3><p className={styles.body}>Approve the delivery, ask for the included revision, or open a dispute before the agreed review window closes.</p></article>
            <article className={styles.cardOnBand}><p className={styles.eyebrow}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>Terms</p><h3 className={styles.h3}>Scope locked at checkout.</h3><p className={styles.body}>Price, deliverables and revisions are fixed when you buy. The deadline starts once the brief is complete.</p></article>
          </div>
        </div>
      </section>

      <section id="how" className={styles.howSection}>
        <div className={styles.containerWide}>
          <LaunchStack />
        </div>
      </section>

      <section className={styles.sectionTight}>
        <div className={styles.container}>
          <h2 className={styles.h2}>Three ways to hire.</h2>
          <div className={styles.grid3}>
            <article className={styles.cardOnBg}><h3 className={styles.h3}>Book</h3><p className={styles.body}>A ready-made service with a fixed price, delivery time and revisions.</p><Link className={styles.more} href="/explore">Browse services ›</Link></article>
            <article className={styles.cardHighlight}><span className={styles.tag}>Built for launches</span><h3 className={styles.h3}>Campaign</h3><p className={styles.body}>One brief, a shared budget and several creators, each with their own order.</p><Link className={styles.more} href="/sign-up?role=buyer">Start a campaign ›</Link></article>
            <article className={styles.cardOnBg}><h3 className={styles.h3}>Auction</h3><p className={styles.body}>Bid for an opening with an in-demand creator, on server-timed rules.</p><Link className={styles.more} href="/auctions">See auctions ›</Link></article>
          </div>
        </div>
      </section>

      <section id="pools" className={styles.sectionTight}>
        <div className={styles.tile}>
          <div className={styles.tileCopy}>
            <p className={styles.kickerOnTile}>Reward pools <span className={`${styles.tag} ${styles.tagOrange}`}>Testnet</span></p>
            <h2 className={styles.h2OnTile}>Fund once. <span className={styles.gradientText}>Pay each creator on approval.</span></h2>
            <p className={styles.bodyOnTile}>Deposit USDC or tokens for the campaign. Each hire reserves its share, approval releases it, and the rest comes back to you. Not live yet.</p>
            <Link className={styles.moreOnTile} href="/sign-up?role=buyer">Join the pilot ›</Link>
          </div>
          <div className={styles.tileVisual}>
            <PoolFlow />
            <ol className={styles.tileSteps}>
              <li><span>1</span><div><strong>Deposit rewards</strong><p>USDC, plus optional tokens, whitelist spots or perks.</p></div></li>
              <li><span>2</span><div><strong>A hire reserves a share</strong><p>Required rewards are set aside before work starts.</p></div></li>
              <li><span>3</span><div><strong>Approval releases it</strong><p>Each reward is paid once. Unused balance is refundable.</p></div></li>
            </ol>
          </div>
        </div>
      </section>

      <section id="creators" className={styles.band}>
        <div className={styles.container}>
          <div className={styles.splitHead}>
            <div><p className={styles.kicker}>For creators</p><h2 className={styles.h2}>Get paid for what you already do well on X.</h2></div>
            <Link className={styles.buttonPrimary} href="/sign-up?role=creator">Apply as a creator</Link>
          </div>
          <div className={styles.grid4}>
            <article className={styles.cardOnBand}><h3 className={styles.h4}>Work from web3 teams</h3><p className={styles.bodySmall}>Briefs from teams that need people who understand the tech.</p></article>
            <article className={styles.cardOnBand}><h3 className={styles.h4}>Never overbooked</h3><p className={styles.bodySmall}>Set how many orders you take at once. Pause anytime.</p></article>
            <article className={styles.cardOnBand}><h3 className={styles.h4}>No scope creep</h3><p className={styles.bodySmall}>Deliverables and revisions agreed before work starts.</p></article>
            <article className={styles.cardOnBand}><h3 className={styles.h4}>Samples over followers</h3><p className={styles.bodySmall}>Strong work gets chosen. No X account connection needed.</p></article>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={`${styles.container} ${styles.splitList}`}>
          <h2 className={styles.h2}>Clear rules for sponsored content.</h2>
          <ul className={styles.rules}>
            <li><h3 className={styles.h4}>Disclosure required</h3><p className={styles.body}>Sponsored posts must be marked as sponsored.</p></li>
            <li data-tone="red"><h3 className={styles.h4}>No profit promises</h3><p className={styles.body}>No trading signals, return claims or disguised promotion.</p></li>
            <li><h3 className={styles.h4}>Reviewed samples</h3><p className={styles.body}>Portfolio samples are moderated before they go public.</p></li>
            <li><h3 className={styles.h4}>Disputes reviewed by people</h3><p className={styles.body}>Payouts pause while a dispute is reviewed, with reasons on record.</p></li>
            <li data-tone="orange"><h3 className={`${styles.h4} ${styles.pending}`}><span className={styles.pendingTag}>[Decision pending]</span> Projects reviewed before campaigns open</h3></li>
          </ul>
        </div>
      </section>

      <section id="ai" className={styles.bandSlim}>
        <div className={`${styles.container} ${styles.aiRow}`}>
          <div><p className={styles.kicker}>AI and SaaS</p><h2 className={styles.h2Small}>Launching an AI or SaaS product? The same creators write launch threads too.</h2></div>
          <Link className={styles.more} href="/explore">Browse creators ›</Link>
        </div>
      </section>

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
        <p className={styles.lead}>Tell us what you are launching. We will match you with creators for a pilot campaign.</p>
        <div className={styles.ctaRow}>
          <Link className={styles.buttonPrimary} href="/sign-up?role=buyer">Request early access</Link>
          <Link className={styles.buttonOutline} href="/sign-up?role=creator">Apply as a creator</Link>
        </div>
      </section>
    </main>

    <footer className={styles.footer}>
      <div className={styles.containerWide}>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <Link href="/" aria-label="spaca home" className={styles.brand}><SpacaLockup size={26} /></Link>
            <p>Creator campaigns for web3 launches, on X. Each creator is paid when their work is approved.</p>
            <span className={styles.footerTag}><span aria-hidden>{'{'}</span> Local build · testnet only <span aria-hidden>{'}'}</span></span>
          </div>
          {FOOTER_COLUMNS.map((column) => <nav key={column.title} className={styles.footerCol} aria-label={column.title}>
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
