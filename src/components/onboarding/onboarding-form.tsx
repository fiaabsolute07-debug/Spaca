'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ImagePlus } from 'lucide-react';
import type { AccountType } from '@/lib/account';
import { FOCUS_OPTIONS, HEADLINE_MAX, INTRO_MAX, INTRO_MIN, MAX_FOCUS, handleFrom, onboardingPath } from '@/lib/onboarding';
import { ACCEPTED_IMAGES } from '../files/file-upload-field';
import { uploadFile } from '../files/upload';
import { WalletLink } from '../crypto/wallet-link';
import { XLogo } from '../x/x-logo';
import { XProfileCard } from '../x/x-profile-card';
import type { XProfileView } from '@/lib/x-profile';

type Initial = { name: string; handle: string; avatarAssetId: string | null; headline: string; bio: string; focus: string[]; link: string };
type Photo = { state: 'empty' | 'uploading' | 'ready' | 'failed'; id: string | null; preview: string | null; message?: string };
type Problem = { field: 'photo' | 'name' | 'handle' | 'headline' | 'bio' | 'form'; text: string };

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** What each account type is asked, in its own words. Buyers name the project; creators name themselves. */
const COPY = {
  creator: {
    eyebrow: 'Creator account · Set up',
    title: 'Set up your creator profile',
    lead: 'Buyers look at your photo, your name and how you introduce yourself before anything else. This takes about two minutes.',
    photo: 'Profile photo', photoHelp: 'A clear photo of you, or the mark you post under on X.',
    name: 'Creator name', nameHelp: 'The name buyers know you by, usually your X name.', namePlaceholder: 'The name on your X profile', previewName: 'Your creator name',
    headline: 'What you do', headlinePlaceholder: 'Launch threads and explainers for DeFi and L2 teams',
    focus: 'Your focus',
    bio: 'Introduce yourself', bioHelp: 'Who you are, what you make, and the teams or launches you have worked with.',
    bioPlaceholder: 'I have written launch threads for three L2 testnets and host a weekly Spaces on restaking…',
    link: 'X profile or website', linkPlaceholder: '@yourname or https://…',
    waits: 'Until setup is done you can look around, but publishing a service and applying to campaigns wait.',
    wallet: 'Crypto payouts go to a wallet you prove you control. You can also do this later from Funds.',
  },
  buyer: {
    eyebrow: 'Buyer account · Set up',
    title: 'Set up your project',
    lead: 'Creators decide which briefs to take by who is asking. Add your logo, the project name and a short introduction.',
    photo: 'Project logo', photoHelp: 'Your project mark. Creators see it next to every brief you post.',
    name: 'Project name', nameHelp: 'Shown on every campaign you post.', namePlaceholder: 'Arcadia Protocol', previewName: 'Your project name',
    headline: 'What you are building', headlinePlaceholder: 'A restaking protocol opening its public testnet',
    focus: 'Category',
    bio: 'About the project', bioHelp: 'What the project does, who it is for, and where it is now: testnet, mainnet, raising.',
    bioPlaceholder: 'Arcadia lets stakers restake once and secure several networks. Public testnet opens in October…',
    link: 'Website or X', linkPlaceholder: 'https://yourproject.xyz or @yourproject',
    waits: 'Until setup is done you can look around and book creators, but posting a campaign waits.',
    wallet: 'Reward pools and crypto checkout use a wallet you prove you control. You can also do this later from Funds.',
  },
} as const;

const hostOf = (value: string) => {
  const trimmed = value.trim();
  if (/^@[A-Za-z0-9_]{1,15}$/.test(trimmed)) return `x.com/${trimmed.slice(1)}`;
  return trimmed.replace(/^https?:\/\//, '').replace(/\/$/, '');
};

/**
 * Account setup after sign-up: photo, name, one line on what the account does, focus, introduction and an optional
 * link, with a live preview of how others will see it. Sends `complete_onboarding`; without JavaScript it is a plain
 * form post and the server gives the same answers.
 */
export function OnboardingForm({ type, next, idempotencyKey, initial, wallets, networks, x = null }: {
  type: AccountType;
  next: string;
  idempotencyKey: string;
  initial: Initial;
  wallets: { id: string; address: string; network: string }[];
  networks: { chain_id: number; name: string; mode: string }[];
  /** Creators only: their connected X account, if any, and whether connecting is possible here. */
  x?: { profile: XProfileView | null; available: boolean; sandbox: boolean } | null;
}) {
  const creator = type === 'creator';
  const copy = COPY[type];
  const formId = useId();
  const ids = { photo: useId(), name: useId(), handle: useId(), headline: useId(), bio: useId(), link: useId(), problem: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<Photo>({ state: initial.avatarAssetId ? 'ready' : 'empty', id: null, preview: initial.avatarAssetId ? `/api/avatars/${initial.avatarAssetId}` : null });
  const [name, setName] = useState(initial.name);
  const [handle, setHandle] = useState(initial.handle);
  const [handleEdited, setHandleEdited] = useState(Boolean(initial.handle));
  const [headline, setHeadline] = useState(initial.headline);
  const [bio, setBio] = useState(initial.bio);
  const [focus, setFocus] = useState<string[]>(initial.focus.filter((item) => (FOCUS_OPTIONS as readonly string[]).includes(item)));
  const [link, setLink] = useState(initial.link);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { if (photo.preview?.startsWith('blob:')) URL.revokeObjectURL(photo.preview); }, [photo.preview]);

  const shownHandle = handleEdited ? handle : handleFrom(name);
  const checks = [
    { label: creator ? 'Photo' : 'Logo', done: photo.state === 'ready' },
    { label: creator ? 'Creator name' : 'Project name', done: name.trim().length > 0 },
    { label: creator ? 'What you do' : 'What you are building', done: headline.trim().length > 0 },
    { label: 'Introduction', done: bio.trim().length >= INTRO_MIN },
  ];
  const done = checks.filter((check) => check.done).length;

  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setPhoto({ state: 'uploading', id: null, preview: URL.createObjectURL(file) });
    try {
      const result = await uploadFile('AVATAR', file);
      setPhoto((current) => ('error' in result
        ? { ...current, state: 'failed', message: result.error }
        : { ...current, state: 'ready', id: result.id }));
    } catch {
      setPhoto((current) => ({ ...current, state: 'failed', message: 'Network error while uploading. Try again.' }));
    }
  }

  function check(): Problem | null {
    if (photo.state === 'uploading') return { field: 'photo', text: 'Wait for the photo to finish uploading.' };
    if (photo.state !== 'ready') return { field: 'photo', text: creator ? 'Add a profile photo.' : 'Add your project logo.' };
    if (!name.trim()) return { field: 'name', text: creator ? 'Add your creator name.' : 'Add the project name.' };
    if (creator && !HANDLE_PATTERN.test(shownHandle)) return { field: 'handle', text: 'Your handle needs 3–32 lowercase letters, numbers, _ or -, starting with a letter or number.' };
    if (!headline.trim()) return { field: 'headline', text: creator ? 'Add one line on what you do.' : 'Add one line on what you are building.' };
    if (bio.trim().length < INTRO_MIN) return { field: 'bio', text: `Write at least ${INTRO_MIN} characters in the introduction (${bio.trim().length} so far).` };
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = check();
    setProblem(found);
    if (found) {
      const target = found.field === 'photo' ? fileInput.current : document.getElementById(ids[found.field as Exclude<Problem['field'], 'form'>]);
      target?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/commands', { method: 'POST', body: new FormData(event.currentTarget), headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (response.ok) {
        // Full navigation so the header shows the new photo and name.
        window.location.assign(body.path || next);
        return;
      }
      setProblem({ field: 'form', text: body.error ?? 'Setup could not be saved. Try again.' });
    } catch {
      setProblem({ field: 'form', text: 'Network error. Your answers are still here; try again.' });
    }
    setBusy(false);
  }

  const problemFor = (field: Problem['field']) => (problem?.field === field ? <p className="onboard-problem" id={ids.problem} role="alert">{problem.text}</p> : null);
  const invalid = (field: Problem['field']) => (problem?.field === field ? { 'aria-invalid': true, 'aria-describedby': ids.problem } : {});
  /** Help text always describes the field; a problem with it is read first. */
  const described = (field: Problem['field'], help: string) => (problem?.field === field ? { 'aria-invalid': true, 'aria-describedby': `${ids.problem} ${help}` } : { 'aria-describedby': help });
  const toggleFocus = (value: string) => setFocus((current) => (current.includes(value) ? current.filter((item) => item !== value) : current.length >= MAX_FOCUS ? current : [...current, value]));

  const initialLetter = (name.trim() || (creator ? 'C' : 'P')).slice(0, 1).toUpperCase();
  const excerpt = bio.trim().length > 180 ? `${bio.trim().slice(0, 177)}…` : bio.trim();

  return <div className="onboard">
    <header className="page-heading onboard-heading">
      <div className="eyebrow">{copy.eyebrow}</div>
      <h1>{copy.title}</h1>
      <p>{copy.lead}</p>
    </header>

    <div className="onboard-layout">
      <div className="onboard-main">
        {x && (x.profile || x.available) ? <section className="onboard-step onboard-x" aria-labelledby={`${formId}-x`}>
          <h2 id={`${formId}-x`}><XLogo size={16} /> Start from X <span className="onboard-optional">(optional)</span></h2>
          {x.profile ? <>
            <p className="onboard-note">Connected. Your name, handle, bio and link were filled in from X where they were empty; change anything below.</p>
            <XProfileCard x={x.profile} variant="compact" />
          </> : <>
            <p className="onboard-note">Connect X to prove the account is yours and fill in your name, handle and bio. Buyers then see your X photo and followers in Explore.{x.sandbox ? ' Local sandbox: a stand-in for X opens; no real X account is used.' : ''}</p>
            <form method="post" action="/api/x/connect">
              <input type="hidden" name="return_to" value={onboardingPath(next)} />
              <button className="button button-outline" type="submit"><XLogo size={14} /> Connect X</button>
            </form>
          </>}
        </section> : null}
        <form id={formId} className="onboard-form" method="post" action="/api/commands" onSubmit={submit}>
          <input type="hidden" name="command" value="complete_onboarding" />
          <input type="hidden" name="idempotency_key" value={idempotencyKey} />
          {/* Without JavaScript, errors come back to this page and success goes on to `next`. */}
          <input type="hidden" name="return_to" value={onboardingPath(next)} />
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="asset_ids" value={photo.state === 'ready' && photo.id ? photo.id : ''} />

          <section className="onboard-step" aria-labelledby={`${ids.photo}-title`}>
            <h2 id={`${ids.photo}-title`}><span className="onboard-step-n">01</span>{copy.photo}</h2>
            <div className="onboard-photo" data-state={photo.state}>
              <button type="button" className="onboard-photo-face" onClick={() => fileInput.current?.click()} tabIndex={-1} aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview or short-lived signed redirect */}
                {photo.preview ? <img src={photo.preview} alt="" width={96} height={96} /> : <span>{name.trim() ? initialLetter : <ImagePlus size={26} />}</span>}
              </button>
              <div className="onboard-photo-side">
                <p>{copy.photoHelp}</p>
                <div className="onboard-photo-actions">
                  <label className="button button-outline compact" htmlFor={ids.photo}>{photo.state === 'empty' ? `Upload ${creator ? 'photo' : 'logo'}` : `Change ${creator ? 'photo' : 'logo'}`}</label>
                  <input ref={fileInput} id={ids.photo} className="onboard-file" type="file" accept={ACCEPTED_IMAGES} {...invalid('photo')}
                    onChange={(event) => { void choosePhoto(event.target.files?.[0]); event.target.value = ''; }} />
                  <span className="onboard-photo-status" aria-live="polite">
                    {photo.state === 'uploading' ? 'Uploading…' : photo.state === 'ready' ? <><Check size={14} aria-hidden /> Ready</> : photo.state === 'failed' ? photo.message : ''}
                  </span>
                </div>
                <small>PNG, JPG, GIF or WebP, up to 10 MB. Square works best.</small>
                {problemFor('photo')}
              </div>
            </div>
          </section>

          <section className="onboard-step" aria-labelledby={`${ids.name}-title`}>
            <h2 id={`${ids.name}-title`}><span className="onboard-step-n">02</span>Name</h2>
            <div className={creator ? 'form-grid' : undefined}>
              <div className="field">
                <label htmlFor={ids.name}>{copy.name}</label>
                <input id={ids.name} name="display_name" value={name} maxLength={100} required autoComplete={creator ? 'nickname' : 'organization'} placeholder={copy.namePlaceholder}
                  onChange={(event) => setName(event.target.value)} {...described('name', `${ids.name}-help`)} />
                <small id={`${ids.name}-help`}>{copy.nameHelp}</small>
              </div>
              {creator && <div className="field">
                <label htmlFor={ids.handle}>Public handle</label>
                <span className="onboard-handle">
                  <span aria-hidden>/creators/</span>
                  <input id={ids.handle} name="handle" value={shownHandle} maxLength={32} required autoCapitalize="none" spellCheck={false} placeholder="yourname"
                    onChange={(event) => { setHandleEdited(true); setHandle(event.target.value.toLowerCase()); }} {...described('handle', `${ids.handle}-help`)} />
                </span>
                <small id={`${ids.handle}-help`}>Your profile link: /creators/{shownHandle || 'yourname'}. Lowercase letters, numbers, _ or -.</small>
              </div>}
            </div>
            {problemFor('name')}
            {problemFor('handle')}
          </section>

          <section className="onboard-step" aria-labelledby={`${ids.headline}-title`}>
            <h2 id={`${ids.headline}-title`}><span className="onboard-step-n">03</span>Introduction</h2>
            <div className="field">
              <label htmlFor={ids.headline}>{copy.headline}</label>
              <input id={ids.headline} name="headline" value={headline} maxLength={HEADLINE_MAX} required placeholder={copy.headlinePlaceholder}
                onChange={(event) => setHeadline(event.target.value)} {...described('headline', `${ids.headline}-help`)} />
              <small className="onboard-count" id={`${ids.headline}-help`}>{headline.length} / {HEADLINE_MAX} characters</small>
            </div>
            {problemFor('headline')}

            <fieldset className="onboard-focus">
              <legend>{copy.focus} <small>(optional, up to {MAX_FOCUS})</small></legend>
              <div className="onboard-focus-options">
                {FOCUS_OPTIONS.map((option) => {
                  const checked = focus.includes(option);
                  return <label key={option} className="onboard-chip">
                    <input type="checkbox" name="focus" value={option} checked={checked} disabled={!checked && focus.length >= MAX_FOCUS} onChange={() => toggleFocus(option)} />
                    <span>{option}</span>
                  </label>;
                })}
              </div>
            </fieldset>

            <div className="field">
              <label htmlFor={ids.bio}>{copy.bio}</label>
              <textarea id={ids.bio} name="bio" value={bio} maxLength={INTRO_MAX} required minLength={INTRO_MIN} rows={5} placeholder={copy.bioPlaceholder}
                onChange={(event) => setBio(event.target.value)} {...described('bio', `${ids.bio}-help`)} />
              <small className="onboard-bio-help" id={`${ids.bio}-help`}><span>{copy.bioHelp}</span><span className="onboard-count">{bio.trim().length < INTRO_MIN ? `${bio.trim().length} / ${INTRO_MIN} minimum` : `${bio.length} / ${INTRO_MAX}`}</span></small>
            </div>
            {problemFor('bio')}

            <div className="field">
              <label htmlFor={ids.link}>{copy.link} <span className="onboard-optional">(optional)</span></label>
              <input id={ids.link} name="link" value={link} maxLength={500} autoCapitalize="none" spellCheck={false} placeholder={copy.linkPlaceholder}
                onChange={(event) => setLink(event.target.value)} />
            </div>
          </section>
        </form>

        {/* Linking a wallet signs and saves on its own, so it sits outside the setup form. */}
        <section className="onboard-step onboard-wallet" aria-labelledby={`${formId}-wallet`}>
          <h2 id={`${formId}-wallet`}><span className="onboard-step-n">04</span>Wallet <span className="onboard-optional">(optional)</span></h2>
          <p className="onboard-note">{copy.wallet}</p>
          {wallets.length > 0 && <ul className="onboard-wallets">
            {wallets.map((wallet) => <li key={wallet.id}><span className="status-dot status-good" aria-hidden /> <span className="mono">{wallet.address}</span> <span className="muted">{wallet.network}</span></li>)}
          </ul>}
          <WalletLink networks={networks} />
        </section>

        <div className="onboard-actions">
          {problemFor('form')}
          <button className="button button-dark" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Finish setup'}</button>
          <Link className="text-link" href={next}>Do this later</Link>
          <p className="onboard-note">{copy.waits}</p>
        </div>
      </div>

      <aside className="onboard-preview" aria-label="Preview">
        <p className="onboard-preview-label">How others see you</p>
        <div className={`onboard-card onboard-card-${type}`}>
          {!creator && <p className="onboard-card-kicker">Campaign by</p>}
          <div className="onboard-card-who">
            <span className="onboard-card-face">
              {/* eslint-disable-next-line @next/next/no-img-element -- local preview or short-lived signed redirect */}
              {photo.preview ? <img src={photo.preview} alt="" width={56} height={56} /> : <span>{initialLetter}</span>}
            </span>
            <div>
              <strong className={name.trim() ? undefined : 'is-empty'}>{name.trim() || copy.previewName}</strong>
              {creator && <span className="onboard-card-handle">@{shownHandle || 'yourname'}</span>}
              <span className="onboard-card-type">{creator ? 'Creator' : 'Buyer'}</span>
            </div>
          </div>
          <p className={`onboard-card-headline${headline.trim() ? '' : ' is-empty'}`}>{headline.trim() || copy.headlinePlaceholder}</p>
          {focus.length > 0 && <div className="chip-row">{focus.map((item) => <span key={item} className="chip">{item}</span>)}</div>}
          <p className={`onboard-card-bio${excerpt ? '' : ' is-empty'}`}>{excerpt || copy.bioHelp}</p>
          {link.trim() && <p className="onboard-card-link">{hostOf(link)}</p>}
        </div>
        <div className="onboard-progress">
          <div className="strength-bar" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={checks.length} aria-valuenow={done}>
            <span style={{ width: `${(done / checks.length) * 100}%` }} />
          </div>
          <ul className="onboard-checks">
            {checks.map((item) => <li key={item.label} className={item.done ? 'done' : ''}><span aria-hidden>{item.done ? '✓' : '○'}</span> {item.label}<span className="visually-hidden">{item.done ? ' (done)' : ' (to do)'}</span></li>)}
          </ul>
        </div>
      </aside>
    </div>
  </div>;
}
