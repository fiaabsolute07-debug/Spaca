import type { Metadata } from 'next';
import styles from '../waitlist.module.css';

export const metadata: Metadata = { title: 'Privacy — spaca waitlist' };

export default function PrivacyPage() {
  return <main className={styles.prose}>
    <a className={styles.back} href="/">‹ Back to waitlist</a>
    <h1>Waitlist privacy</h1>
    <p>Draft for the waitlist only. [REVIEW WITH LEGAL BEFORE PUBLIC LAUNCH]</p>
    <h2>What we collect</h2>
    <ul>
      <li>Your email address and whether you are a project or a creator.</li>
      <li>Optionally, an X handle you choose to add.</li>
      <li>Where you came from (campaign tags such as utm_source, and the referring site).</li>
      <li>A one-way salted hash of your IP address, used only to limit spam. We do not store the address itself.</li>
    </ul>
    <h2>How we use it</h2>
    <p>To contact you about early access to spaca and to understand which channels bring people to the waitlist. We do not sell it or share it for advertising.</p>
    <h2>Removal</h2>
    <p>Email <a href="mailto:fia.absolute07@gmail.com">fia.absolute07@gmail.com</a> and we will delete your waitlist entry.</p>
  </main>;
}
