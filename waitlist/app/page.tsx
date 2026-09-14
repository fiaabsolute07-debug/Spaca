import { SpacaLockup } from '../components/spaca-logo';
import { WaitlistForm } from '../components/waitlist-form';
import styles from './waitlist.module.css';

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function WaitlistPage({ searchParams }: { searchParams: Search }) {
  const query = await searchParams;
  const token = typeof query.t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(query.t) ? query.t : null;
  const role = query.r === 'creator' ? 'creator' : 'project';
  const resume = query.step === 'handle' && token ? { token, role } as const : null;

  return <div className={styles.page}>
    <header className={styles.header}>
      <SpacaLockup size={28} />
      <span className={styles.badge}>Private beta</span>
    </header>

    <main className={styles.main}>
      <div className={styles.copy}>
        <h1 className={styles.title}>Creator campaigns for web3 launches, on X.</h1>
        <p className={styles.lead}>Hire crypto-native researchers, writers and KOLs from one brief. Each creator is paid when their work is approved. Join the waitlist for early access.</p>
      </div>
      <WaitlistForm resume={resume} />
      <p className={styles.fineprint}>Takes 10 seconds. No wallet or X login needed.</p>
    </main>

    <footer className={styles.footer}>
      <span>© {new Date().getFullYear()} spaca</span>
      <a href="/privacy">Privacy</a>
    </footer>
  </div>;
}
