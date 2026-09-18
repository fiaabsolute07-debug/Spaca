'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Mail, Megaphone, PenTool, X } from 'lucide-react';
import { SpacaMark } from '../brand/spaca-logo';
import { XLogo } from '../x/x-logo';
import { GoogleLogo } from '../brand/google-logo';

export type TestAccount = { persona: string; name: string; role: string; returnTo: string };

type Props = {
  mode: 'signin' | 'signup';
  /** Overlay over the current page (intercepted route) or a standalone card (direct visit to /sign-in). */
  variant: 'modal' | 'page';
  returnTo: string;
  /** Preselected account type when the link says who is joining (?role=creator); otherwise the person chooses. */
  defaultRole?: AccountChoice | null;
  initialError?: string | null;
  initialMessage?: string | null;
  testAccounts: TestAccount[];
  /** Whether "Continue with X" works here, and whether it opens the local stand-in for X. */
  x: { available: boolean; sandbox: boolean };
  /** The same for "Continue with Google", which signs in to accounts that connected Google in settings. */
  google: { available: boolean; sandbox: boolean };
  /** Whether the dialog offers email and password at all (EMAIL_SIGN_IN). */
  emailSignIn: boolean;
};

type AccountChoice = 'buyer' | 'creator';

const BENEFITS = {
  signin: ['Crypto-native creators on X', 'Clear scopes and real work samples', 'Creators are paid when their work is approved'],
  signup: ['One brief, many creators', 'Every order has a clear scope and review', 'Creators are paid when their work is approved'],
  buyer: ['Post one brief and hear from many creators', 'Pay each creator when you approve their work', 'No wallet needed to hire'],
  creator: ['Offer services with a clear scope and price', 'Apply to campaigns from web3 projects', 'Get paid when your work is approved'],
};

/** Buyer and creator accounts are separate (2026-09-15), so the choice comes first and is made on purpose. */
const ACCOUNT_CHOICES: { value: AccountChoice; title: string; line: string; icon: typeof Megaphone }[] = [
  { value: 'buyer', title: 'Buyer', line: 'I run a project and want to hire creators for campaigns.', icon: Megaphone },
  { value: 'creator', title: 'Creator', line: 'I write, design, post or host, and want to be hired.', icon: PenTool },
];

/**
 * Sign in / create account in one dialog. New accounts sign up with X or Google (after choosing Buyer or Creator); an
 * email and password can be added later from account settings, and then sign in here too. "Continue with X" and
 * "Continue with Google" are form posts to /api/auth/x and /api/auth/google; email sign-in posts to /api/auth as JSON so
 * errors show in place; test accounts (local sandbox only) post to /api/dev/session.
 */
export function AuthDialog({ mode: initialMode, variant, returnTo, defaultRole = null, initialError = null, initialMessage = null, testAccounts, x, google, emailSignIn }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [view, setView] = useState<'options' | 'email'>('options');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<AccountChoice | null>(defaultRole);
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
    setView('options');
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
      <h2>{!signup ? 'Launches start here' : role === 'creator' ? 'Get hired for the work you do best' : role === 'buyer' ? 'Find the voices your launch needs' : 'Good work starts with a hello'}</h2>
      <ul>
        {BENEFITS[signup && role ? role : mode].map((benefit) => <li key={benefit}><Check size={18} strokeWidth={2.5} /> {benefit}</li>)}
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
        {signup && <fieldset className="account-choice">
          <legend>Choose your account type</legend>
          {ACCOUNT_CHOICES.map((choice) => <label key={choice.value} className="account-choice-card">
            <input type="radio" name="account_choice" value={choice.value} checked={role === choice.value} onChange={() => setRole(choice.value)} />
            <span className="account-choice-icon" aria-hidden><choice.icon size={20} /></span>
            <span className="account-choice-text"><strong>{choice.title}</strong><span>{choice.line}</span></span>
            <span className="account-choice-tick" aria-hidden><Check size={14} strokeWidth={3} /></span>
          </label>)}
          <p className="account-choice-note">Each account is one type and signs in with its own X or Google account.</p>
        </fieldset>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <form action="/api/auth/x" method="post" className="auth-x">
          <input type="hidden" name="intent" value={signup ? 'signup' : 'signin'} />
          <input type="hidden" name="return_to" value={returnTo} />
          {signup && <input type="hidden" name="role" value={role ?? ''} />}
          <button type="submit" className="auth-option auth-option-x" disabled={!x.available || (signup && !role)}
            aria-describedby={signup && !role ? `${titleId}-choose` : undefined}>
            <XLogo size={16} /> <span>Continue with X</span>
          </button>
        </form>
        {signup && !role && <p className="account-choice-hint" id={`${titleId}-choose`}>Choose Buyer or Creator to continue.</p>}
        {!x.available && <p className="account-choice-hint">Signing in with X is not available in this environment.</p>}
        {(google.available || (!signup && emailSignIn)) && <div className="auth-divider"><span>or</span></div>}
        {google.available && <form action="/api/auth/google" method="post" className="auth-x">
          <input type="hidden" name="intent" value={signup ? 'signup' : 'signin'} />
          <input type="hidden" name="return_to" value={returnTo} />
          {signup && <input type="hidden" name="role" value={role ?? ''} />}
          <button type="submit" className="auth-option" disabled={signup && !role}
            aria-describedby={signup && !role ? `${titleId}-choose` : undefined}>
            <GoogleLogo size={18} /> <span>Continue with Google</span>
          </button>
        </form>}
        {!signup && emailSignIn && <button type="button" className="auth-option" onClick={() => { setView('email'); setError(null); }}>
          <Mail size={18} aria-hidden /> <span>Continue with email</span>
        </button>}
        {/* With X the only way in, a note about the other two would describe buttons that are not on the dialog. */}
        <p className="account-choice-next">{signup
          ? google.available
            ? 'Either one creates the account. You can add an email and password in your account settings afterwards.'
            : 'Your X account creates the account. You can add an email and password in your account settings afterwards.'
          : google.available && emailSignIn ? 'Google and email work once you have connected them to your account.'
            : google.available ? 'Google works once you have connected it to your account.'
              : emailSignIn ? 'Email works once you have added one to your account.'
                : 'Sign in with the X account you signed up with.'}</p>
        {(x.sandbox || google.sandbox) && <p className="auth-sandbox-note">Local sandbox: {x.sandbox && google.sandbox ? 'X and Google open stand-in pages' : x.sandbox ? 'X opens a stand-in page' : 'Google opens a stand-in page'}. No real account is used.</p>}
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
        <input type="hidden" name="action" value="login" />
        <input type="hidden" name="return_to" value={returnTo} />
        <label className="field"><span>Email address</span><input name="email" type="email" required autoComplete="email" autoFocus /></label>
        <label className="field"><span>Password</span>
          <input name="password" type="password" required minLength={12} autoComplete="current-password" /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
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
