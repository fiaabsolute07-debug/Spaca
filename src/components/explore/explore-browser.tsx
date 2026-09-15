'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar } from '../avatar';
import { availabilityLabel, money, num, rows, str, type Row } from '../ui';

const CATEGORY: Record<string, string> = { CREATE: 'Create', PUBLISH: 'Publish', ACCESS: 'Access', DIGITAL: 'Digital' };
const FORMAT: Record<string, string> = { POST: 'post', THREAD: 'thread', QUOTE_POST: 'quote post', VIDEO: 'video', NEWSLETTER_ISSUE: 'newsletter issue', ARTICLE: 'article' };
const delivery = (hours: unknown) => {
  const h = num(hours);
  return h <= 24 ? `${h} ${h === 1 ? 'hour' : 'hours'}` : `${Math.ceil(h / 24)} days`;
};

/** What the buyer receives, per category, from the published version's terms. */
function Included({ s }: { s: Row }) {
  const items: string[] = [];
  const taxonomy = str(s.taxonomy);
  if (taxonomy === 'PUBLISH') {
    items.push(`One ${FORMAT[str(s.publish_format)] ?? 'post'} on ${s.publish_handle ? `@${str(s.publish_handle)}` : 'the creator’s channel'} (${str(s.publish_platform)}), labelled “${str(s.disclosure_text)}”`);
    items.push(`Stays live for at least ${num(s.min_live_hours)} hours`);
  } else if (taxonomy === 'ACCESS') {
    items.push(`A ${num(s.access_session_minutes)}-minute live session`);
    items.push('You agree the time and meeting link in the order messages');
  } else if (taxonomy === 'DIGITAL') {
    items.push(s.digital_license === 'EXCLUSIVE' ? 'Exclusive license (one buyer)' : 'Non-exclusive license');
    items.push(s.digital_updates === 'LATEST' ? 'Every new version the creator releases' : 'The version current at purchase');
    items.push(`Up to ${num(s.digital_download_limit)} downloads`);
  } else {
    items.push('Content handed to you to use');
  }
  if (taxonomy !== 'DIGITAL' && taxonomy !== 'ACCESS') items.push(`${num(s.revision_limit)} ${num(s.revision_limit) === 1 ? 'revision' : 'revisions'} included`);
  return <ul className="included-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function Detail({ s }: { s: Row }) {
  const availability = availabilityLabel(s.availability_status);
  return <article className="explore-detail" aria-label={`Details: ${str(s.title)}`}>
    <header className="explore-detail-head">
      <span className="chip">{CATEGORY[str(s.taxonomy)] ?? str(s.taxonomy)}</span>
      <h2>{str(s.title)}</h2>
      <Link className="detail-creator" href={s.handle ? `/creators/${str(s.handle)}` : '#'}>
        <Avatar name={s.creator_name} assetId={s.avatar_asset_id} size={32} />
        <span>
          <strong>{str(s.creator_name, 'Creator')}</strong>
          <small>{[str(s.headline) || str(s.niche), s.rating ? `★ ${str(s.rating)} (${num(s.review_count)})` : '', num(s.completed_jobs) ? `${num(s.completed_jobs)} completed` : 'New creator'].filter(Boolean).join(' · ')}</small>
        </span>
      </Link>
      <div className="chip-row">
        <span className="chip chip-strong">{money(s.price_minor)}</span>
        <span className="chip">{str(s.taxonomy) === 'DIGITAL' ? 'Instant download' : `Delivery in ${delivery(s.turnaround_hours)}`}</span>
        <span className={`chip ${availability.className}`}>{availability.label}</span>
      </div>
      <div className="detail-actions">
        <Link className="button" href={`/services/${str(s.id)}`}>{availability.accepting ? (str(s.taxonomy) === 'DIGITAL' ? 'Buy license' : 'Book this service') : 'View service'}</Link>
        <Link className="text-link" href={`/services/${str(s.id)}`}>View full page ›</Link>
      </div>
    </header>
    <div className="explore-detail-body">
      <h3>About this service</h3>
      <p className="prewrap">{str(s.description, str(s.summary))}</p>
      <h3>What you get</h3>
      <Included s={s} />
      {rows(s.samples).length > 0 && <>
        <h3>Work samples</h3>
        <ul className="sample-links">
          {rows(s.samples).map((sample) => <li key={str(sample.url)}><a className="text-link" href={str(sample.url)} target="_blank" rel="noreferrer nofollow">{str(sample.title, 'Sample')} ›</a></li>)}
        </ul>
      </>}
    </div>
  </article>;
}

/**
 * Results list with a sticky detail panel (desktop). Cards are real links to the service page: on narrow screens they
 * navigate; on wide screens a click selects the card and keeps `selected` in the URL so the choice survives reloads.
 */
export function ExploreBrowser({ items, initialSelected }: { items: Row[]; initialSelected: string }) {
  const [selected, setSelected] = useState(items.some((i) => str(i.id) === initialSelected) ? initialSelected : str(items[0]?.id));
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const current = items.find((i) => str(i.id) === selected) ?? items[0];

  function choose(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (!wide || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set('selected', id);
    window.history.replaceState(null, '', url);
  }

  return <div className="explore-layout">
    <ol className="explore-list" aria-label="Services">
      {items.map((s) => {
        const active = wide && str(s.id) === str(current?.id);
        const availability = availabilityLabel(s.availability_status);
        return <li key={str(s.id)}>
          <a href={`/services/${str(s.id)}`} className={`explore-card${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined} onClick={(event) => choose(event, str(s.id))}>
            <span className="explore-card-creator">
              <Avatar name={s.creator_name} assetId={s.avatar_asset_id} size={24} />
              <span>{str(s.creator_name, 'Creator')}</span>
              {s.niche && str(s.niche) !== 'Independent creator' ? <span className="muted">· {str(s.niche)}</span> : null}
            </span>
            <h3>{str(s.title)}</h3>
            <span className="explore-card-price">{money(s.price_minor)}</span>
            <span className="chip-row">
              <span className="chip">{CATEGORY[str(s.taxonomy)] ?? str(s.taxonomy)}</span>
              <span className="chip">{str(s.taxonomy) === 'DIGITAL' ? 'Instant' : delivery(s.turnaround_hours)}</span>
              {s.rating ? <span className="chip">★ {str(s.rating)}</span> : null}
            </span>
            <span className="explore-card-foot">
              <span className={availability.className}>{availability.label}</span>
              {num(s.completed_jobs) > 0 ? <span className="muted">{num(s.completed_jobs)} completed</span> : <span className="muted">New creator</span>}
            </span>
          </a>
        </li>;
      })}
    </ol>
    {current ? <Detail s={current} /> : null}
  </div>;
}
