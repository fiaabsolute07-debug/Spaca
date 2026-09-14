'use client';

import { useEffect, useRef, useState } from 'react';
import styles from '../app/waitlist.module.css';

type Role = 'project' | 'creator';
type Stage = { name: 'form' } | { name: 'joined'; token: string | null } | { name: 'done'; handle: string | null };

const ROLES: { value: Role; label: string }[] = [
  { value: 'project', label: "I'm launching a project" },
  { value: 'creator', label: "I'm a creator" },
];

function attribution(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const source: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'ref']) {
    const value = params.get(key);
    if (value) source[key] = value;
  }
  if (document.referrer && !document.referrer.startsWith(window.location.origin)) source.referrer = document.referrer;
  return source;
}

async function send(method: 'POST' | 'PATCH', body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const response = await fetch('/api/waitlist', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: { error: 'Network error. Check your connection and try again.' } };
  }
}

function Check() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>;
}

/** `resume` comes from the welcome email link and opens the optional X handle step directly. */
export function WaitlistForm({ resume }: { resume?: { token: string; role: Role } | null }) {
  const [role, setRole] = useState<Role>(resume?.role ?? 'project');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<Stage>(resume ? { name: 'joined', token: resume.token } : { name: 'form' });
  const [handle, setHandle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stage.name !== 'form') successRef.current?.focus();
  }, [stage.name]);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (!consent) { setError('Please agree to receive updates so we can contact you.'); return; }
    setPending(true);
    const { ok, data } = await send('POST', { email, role, consent, website: honeypotRef.current?.value ?? '', source: attribution() });
    setPending(false);
    if (!ok) { setError(String(data.error ?? 'Something went wrong. Please try again.')); return; }
    setStage({ name: 'joined', token: typeof data.token === 'string' ? data.token : null });
  }

  async function addHandle(event: React.FormEvent) {
    event.preventDefault();
    if (pending || stage.name !== 'joined' || !stage.token) return;
    setError(null);
    setPending(true);
    const { ok, data } = await send('PATCH', { token: stage.token, x_handle: handle });
    setPending(false);
    if (!ok) { setError(String(data.error ?? 'Something went wrong. Please try again.')); return; }
    setStage({ name: 'done', handle: String(data.x_handle) });
  }

  if (stage.name !== 'form') {
    const askHandle = stage.name === 'joined' && stage.token !== null;
    return <div ref={successRef} tabIndex={-1} className={styles.card} role="status" aria-live="polite">
      <div className={styles.successIcon}><Check /></div>
      <h2 className={styles.successTitle}>{resume && !email ? 'Welcome back.' : <>You&apos;re on the list.</>}</h2>
      <p className={styles.successBody}>
        {resume && !email
          ? stage.name === 'done'
            ? <>Thanks. We&apos;ll review {role === 'project' ? 'your project' : 'your work'} and reach out by email.</>
            : <>You&apos;re already on the spaca waitlist. Add your X handle below to help us review {role === 'project' ? 'your project' : 'your work'}.</>
          : <>
            {role === 'project' ? 'Thanks for your interest in spaca. ' : 'Thanks for applying as a founding creator. '}
            {askHandle ? <>Check <strong>{email.trim().toLowerCase()}</strong> for a welcome email with next steps.</> : <>We&apos;ll reach out to <strong>{email.trim().toLowerCase()}</strong> when {role === 'project' ? 'early access opens for your launch' : 'creator spots open'}.</>}
          </>}
      </p>

      {askHandle && <form className={styles.step} onSubmit={addHandle} noValidate>
        <label className={styles.stepLabel} htmlFor="x-handle">
          {role === 'project' ? "Optional: your project's X handle" : 'Optional: your X handle'}
          <span>Helps us review {role === 'project' ? 'your project' : 'your work'} faster.</span>
        </label>
        <div className={styles.inputRow}>
          <input id="x-handle" className={styles.input} value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={60} />
          <button className={styles.primary} type="submit" disabled={pending || !handle.trim()}>{pending ? 'Saving…' : 'Add'}</button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="button" className={styles.skip} onClick={() => { setError(null); setStage({ name: 'done', handle: null }); }}>Skip</button>
      </form>}

      {stage.name === 'done' && stage.handle && <p className={styles.handleSaved}>Added @{stage.handle}.</p>}
    </div>;
  }

  return <form className={styles.card} onSubmit={join} noValidate>
    <div className={styles.roles} role="radiogroup" aria-label="I am">
      {ROLES.map((option) => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={role === option.value}
        className={styles.role}
        onClick={() => setRole(option.value)}
      >{option.label}</button>)}
    </div>

    <label className={styles.srOnly} htmlFor="email">Email address</label>
    <div className={styles.inputRow}>
      <input
        id="email"
        className={styles.input}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        maxLength={254}
      />
      <button className={styles.primary} type="submit" disabled={pending}>{pending ? 'Joining…' : role === 'project' ? 'Get early access' : 'Join as creator'}</button>
    </div>

    {/* Hidden from people; bots that fill every field are silently ignored. */}
    <div className={styles.honeypot} aria-hidden>
      <label htmlFor="website">Website</label>
      <input ref={honeypotRef} id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
    </div>

    <label className={styles.consent}>
      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      <span>I agree to receive early-access updates from spaca. <a href="/privacy">Privacy</a></span>
    </label>

    {error && <p className={styles.error} role="alert">{error}</p>}
  </form>;
}
