'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Avatar } from '../avatar';
import { availabilityLabel, money, num, rows, str, type Row } from '../ui';
import { SampleGallery } from '../samples/sample-gallery';
import { XFollowerChip, XProfileCard } from '../x/x-profile-card';
import type { XProfileView } from '@/lib/x-profile';

const xOf = (s: Row) => (s.x ? s.x as unknown as XProfileView : null);

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

function Detail({ s, onClose }: { s: Row; onClose: () => void }) {
  const availability = availabilityLabel(s.availability_status);
  const x = xOf(s);
  return <article className="explore-detail" aria-label={`Details: ${str(s.title)}`}>
    <header className="explore-detail-head">
      <button type="button" className="detail-close" onClick={onClose} aria-label="Close details"><X size={18} aria-hidden /></button>
      <span className="chip">{CATEGORY[str(s.taxonomy)] ?? str(s.taxonomy)}</span>
      <h2>{str(s.title)}</h2>
      <Link className="detail-creator" href={s.handle ? `/creators/${str(s.handle)}` : '#'}>
        <Avatar name={s.creator_name} assetId={s.avatar_asset_id} imageUrl={x?.imageUrl} size={32} />
        <span>
          <strong>{str(s.creator_name, 'Creator')}</strong>
          <small>{[str(s.headline) || str(s.niche), s.rating ? `★ ${str(s.rating)} (${num(s.review_count)})` : '', num(s.completed_jobs) ? `${num(s.completed_jobs)} completed` : 'New creator'].filter(Boolean).join(' · ')}</small>
        </span>
      </Link>
      {x ? <XProfileCard x={x} /> : null}
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
        <SampleGallery samples={rows(s.samples)} label="Work samples" />
      </>}
    </div>
  </article>;
}

/**
 * Two states, like a job board: without a selection, filters sit beside wide result cards; selecting a card (wide
 * screens) hides the filters and shows the list beside a sticky detail panel, closable back to the filters. Cards are
 * real links, so narrow screens and clicks before hydration open the service page. `selected` is kept in the URL.
 */
export function ExploreBrowser({ items, initialSelected, sidebar, toolbar, pager, empty, filterCount }: {
  items: Row[];
  initialSelected: string;
  sidebar: ReactNode;
  toolbar: ReactNode;
  pager: ReactNode;
  empty: ReactNode;
  filterCount: number;
}) {
  const [selected, setSelected] = useState(items.some((i) => str(i.id) === initialSelected) ? initialSelected : '');
  const [wide, setWide] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const current = items.find((i) => str(i.id) === selected);
  // Opening a creator whose saved X profile is old queues one background refresh (never an X read from this page).
  const queued = useRef(new Set<string>());
  useEffect(() => {
    const x = current ? xOf(current) : null;
    const creatorId = str(current?.creator_id);
    if (!x?.refreshDue || !creatorId || queued.current.has(creatorId)) return;
    queued.current.add(creatorId);
    void fetch('/api/x/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creator_id: creatorId }) }).catch(() => undefined);
  }, [current]);

  const setUrl = (id: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('selected', id);
    else url.searchParams.delete('selected');
    window.history.replaceState(null, '', url);
  };
  function choose(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (!wide || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setSelected(id);
    setUrl(id);
  }
  const close = () => {
    setSelected('');
    setUrl('');
  };

  return <div className={`explore-shell${current ? ' is-detail' : ''}${filtersOpen ? ' show-filters' : ''}`}>
    <button type="button" className="button button-outline compact filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
      Filters{filterCount ? ` (${filterCount})` : ''}
    </button>
    <aside className="explore-sidebar" aria-label="Filters">{sidebar}</aside>
    <section className="explore-results" aria-label="Results">
      {toolbar}
      {items.length ? <ol className="explore-list" aria-label="Services">
        {items.map((s) => {
          const active = str(s.id) === str(current?.id);
          const availability = availabilityLabel(s.availability_status);
          return <li key={str(s.id)}>
            <a href={`/services/${str(s.id)}`} className={`explore-card${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined} onClick={(event) => choose(event, str(s.id))}>
              <Avatar name={s.creator_name} assetId={s.avatar_asset_id} imageUrl={xOf(s)?.imageUrl} size={40} className="explore-card-avatar" />
              <span className="explore-card-main">
                <span className="explore-card-headline">
                  <h3>{str(s.title)}</h3>
                  <span className="explore-card-price">{money(s.price_minor)}</span>
                </span>
                <span className="explore-card-creator">
                  {str(s.creator_name, 'Creator')}
                  {s.niche && str(s.niche) !== 'Independent creator' ? <span className="muted"> · {str(s.niche)}</span> : null}
                </span>
                <span className="chip-row">
                  <span className="chip">{CATEGORY[str(s.taxonomy)] ?? str(s.taxonomy)}</span>
                  <span className="chip">{str(s.taxonomy) === 'DIGITAL' ? 'Instant' : delivery(s.turnaround_hours)}</span>
                  {s.rating ? <span className="chip">★ {str(s.rating)}</span> : null}
                  {xOf(s) && !xOf(s)!.unavailable ? <XFollowerChip x={xOf(s)!} /> : null}
                </span>
                <span className="explore-card-foot">
                  <span className="muted explore-card-summary">{str(s.summary)}</span>
                  <span className="explore-card-status">
                    <span className={availability.className}>{availability.label}</span>
                    <span className="muted">{num(s.completed_jobs) > 0 ? `${num(s.completed_jobs)} completed` : 'New creator'}</span>
                  </span>
                </span>
              </span>
            </a>
          </li>;
        })}
      </ol> : empty}
      {pager}
    </section>
    {current ? <Detail s={current} onClose={close} /> : null}
  </div>;
}
