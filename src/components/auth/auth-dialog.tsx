'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Mail, X } from 'lucide-react';
import { SpacaMark } from '../brand/spaca-logo';
import { Select } from '../select';

export type TestAccount = { persona: string; name: string; role: string; returnTo: string };

type Props = {
  mode: 'signin' | 'signup';
  /** Overlay over the current page (intercepted route) or a standalone card (direct visit to /sign-in). */
  variant: 'modal' | 'page';
  returnTo: string;
  defaultRole?: 'buyer' | 'creator';
  initialError?: string | null;
  initialMessage?: string | null;
  testAccounts: TestAccount[];
};

const BENEFITS = {
  signin: ['Crypto-native creators on X', 'Clear scopes and real work samples', 'Creators are paid when their work is approved'],
  signup: ['One brief, many creators', 'Hire, offer your skills, or both', 'Every order has a clear scope and review'],
};

/**
 * Sign in / create account in one dialog. Email and password post to /api/auth as JSON so errors show in place; test
 * accounts (local sandbox only) post to /api/dev/session. Social sign-in is not offered until an identity provider is
 * configured.
 */
export function AuthDialog({ mode: initialMode, variant, returnTo, defaultRole = 'buyer', initialError = null, initialMessage = null, testAccounts }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [view, setView] = useState<'options' | 'email'>(initialError ? 'email' : 'options');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const signup = mode === 'signup';

  const close = () => {
    if (variant !== 'modal') return;
    if (window.history.length > 1) router.back();
    else router.push('/');
  };

  useEffect(() => {
    if (variant !== 'modal') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      // Keep keyboard focus inside the dialog.
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([type=hidden]), [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus();
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once per dialog
  }, [variant]);

  const switchMode = (next: 'signin' | 'signup') => {
    setMode(next);
    setError(null);
    if (variant === 'modal') window.history.replaceState(null, '', next === 'signup' ? '/sign-up' : '/sign-in');
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth', { method: 'POST', body: new FormData(event.currentTarget), headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { redirect?: string; error?: string; message?: string };
      if (response.ok && body.redirect) {
        // Full navigation so the header and every server component read the new session.
        window.location.assign(body.redirect);
        return;
      }
      setError(body.error ?? 'Something went wrong. Try again.');
    } catch {
      setError('Network error. Try again.');
    }
    setBusy(false);
  }

  const card = <div
    ref={dialogRef}
    className={`auth-dialog auth-dialog-${variant}`}
    role={variant === 'modal' ? 'dialog' : undefined}
    aria-modal={variant === 'modal' ? true : undefined}
    aria-labelledby={titleId}
    onClick={(event) => event.stopPropagation()}
  >
    <div className="auth-art" aria-hidden="true">
      <h2>{signup ? 'Good work starts with a hello' : 'Launches start here'}</h2>
      <ul>
        {BENEFITS[mode].map((benefit) => <li key={benefit}><Check size={18} strokeWidth={2.5} /> {benefit}</li>)}
      </ul>
      <div className="auth-art-mark"><SpacaMark size={220} /></div>
    </div>
    <div className="auth-panel">
      {variant === 'modal' && <button type="button" className="auth-close" onClick={close} aria-label="Close"><X size={20} aria-hidden /></button>}
      {view === 'email' && <button type="button" className="auth-back" onClick={() => { setView('options'); setError(null); }}><ArrowLeft size={16} aria-hidden /> Back</button>}
      <h1 id={titleId}>{signup ? 'Create your account' : 'Sign in to your account'}</h1>
      <p className="auth-switch">
        {signup ? 'Already have an account? ' : 'Don’t have an account? '}
        <button type="button" className="link-button" onClick={() => switchMode(signup ? 'signin' : 'signup')}>{signup ? 'Sign in' : 'Join here'}</button>
      </p>
      {initialMessage && <p className="notice" role="status">{initialMessage}</p>}

      {view === 'options' ? <div className="auth-options">
        <button type="button" className="auth-option" onClick={() => setView('email')}>
          <Mail size={18} aria-hidden /> <span>Continue with email</span>
        </button>
        {testAccounts.length > 0 && !signup && <>
          <div className="auth-divider"><span>Local test accounts</span></div>
          <ul className="auth-test-accounts">
            {testAccounts.map((account) => <li key={account.persona}>
              <form action="/api/dev/session" method="post">
                <input type="hidden" name="persona" value={account.persona} />
                <input type="hidden" name="return_to" value={returnTo === '/dashboard' ? account.returnTo : returnTo} />
                <button type="submit" className="auth-test-account">
                  <strong>{account.name}</strong>
                  <span>{account.role}</span>
                </button>
              </form>
            </li>)}
          </ul>
        </>}
      </div> : <form className="auth-email" onSubmit={submit} action="/api/auth" method="post">
        <input type="hidden" name="action" value={signup ? 'signup' : 'login'} />
        <input type="hidden" name="return_to" value={returnTo} />
        {signup && <label className="field"><span>Your name</span><input name="display_name" required maxLength={100} autoComplete="name" /></label>}
        <label className="field"><span>Email address</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
        <label className="field"><span>Password {signup ? '(at least 12 characters)' : ''}</span>
          <input name="password" type="password" required minLength={12} autoComplete={signup ? 'new-password' : 'current-password'} /></label>
        {signup && <div className="field"><span id={`${titleId}-role`}>What brings you here?</span>
          <Select name="role" labelledBy={`${titleId}-role`} defaultValue={defaultRole}
            options={[{ value: 'buyer', label: 'I want to hire creators' }, { value: 'creator', label: 'I want to offer my skills' }]} /></div>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
      </form>}

      <p className="auth-legal">
        By joining, you agree to the spaca <Link href="/terms">Terms of Service</Link>. Read our <Link href="/privacy">Privacy Policy</Link> to learn how we use your personal data.
        {testAccounts.length > 0 && ' Local sandbox: no email is sent and no real payments are processed.'}
      </p>
    </div>
  </div>;

  if (variant === 'page') return <main className="auth-page">{card}</main>;
  return <div className="auth-backdrop" onClick={close}>{card}</div>;
}
