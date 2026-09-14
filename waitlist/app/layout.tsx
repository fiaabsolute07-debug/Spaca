import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'spaca — Early access',
  description: 'Creator campaigns on X for web3 launches. Join the spaca waitlist for early access.',
  openGraph: { title: 'spaca — Early access', description: 'Creator campaigns on X for web3 launches. Join the waitlist.' },
  twitter: { card: 'summary', title: 'spaca — Early access', description: 'Creator campaigns on X for web3 launches. Join the waitlist.' },
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#000000' }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
