import Link from 'next/link';
import { Plus, Search, SlidersHorizontal } from 'lucide-react';
import { getActor } from '@/lib/auth';
import { isCreator } from '@/lib/account';
import { EXPLORE_DELIVERY, EXPLORE_PRICES, EXPLORE_SORTS, getExploreData } from '@/lib/read-model';
import { Select } from '@/components/select';
import { Empty, rows } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { ExploreBrowser } from '@/components/explore/explore-browser';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

const CATEGORIES: [string, string][] = [['', 'All categories'], ['CREATE', 'Create · content'], ['PUBLISH', 'Publish · posts'], ['ACCESS', 'Access · sessions'], ['DIGITAL', 'Digital · files']];

type Option = { value: string; label: string };

/** One filter as a group of radio-styled links: works before scripts load and keeps the other filters. */
function FilterGroup({ title, options, current, href }: { title: string; options: Option[]; current: string; href: (value: string) => string }) {
  return <div className="filter-group">
    <h3 id={`filter-${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</h3>
    <ul role="radiogroup" aria-labelledby={`filter-${title.toLowerCase().replaceAll(' ', '-')}`}>
      {options.map((option) => {
        const on = option.value === current;
        return <li key={option.value || 'all'}>
          <Link href={href(option.value)} role="radio" aria-checked={on} className={`filter-radio${on ? ' is-on' : ''}`} scroll={false}>
            <span className="radio-dot" aria-hidden="true" />{option.label}
          </Link>
        </li>;
      })}
    </ul>
  </div>;
}

export default async function ExplorePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const [data, actor] = await Promise.all([getExploreData(query), getActor()]);
  const f = data.filters;
  const items = rows(data.items);

  const current: Record<string, string> = { q: f.q, category: f.category, niche: f.niche, price: f.price, delivery: f.delivery, available: f.available ? '1' : '', sort: f.sort };
  // Links keep every filter except the ones being changed; the page cursor and the selected card never survive a change.
  const hrefWith = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...current, ...changes })) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `/explore?${text}` : '/explore';
  };
  const hidden = (except: string[]) => Object.entries(current).filter(([key, value]) => value && !except.includes(key))
    .map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />);

  const active = [
    f.q && { label: `“${f.q}”`, href: hrefWith({ q: null, sort: null }) },
    f.category && { label: CATEGORIES.find(([value]) => value === f.category)![1], href: hrefWith({ category: null }) },
    f.price && { label: EXPLORE_PRICES[f.price]!.label, href: hrefWith({ price: null }) },
    f.delivery && { label: EXPLORE_DELIVERY[f.delivery]!, href: hrefWith({ delivery: null }) },
    f.niche && { label: f.niche, href: hrefWith({ niche: null }) },
    f.available && { label: 'Accepting orders', href: hrefWith({ available: null }) },
  ].filter(Boolean) as { label: string; href: string }[];
  const sorts = Object.entries(EXPLORE_SORTS).filter(([value]) => value !== 'relevance' || f.q);

  // Elements handed to the client browser carry keys: it places them among its own children.
  const sidebar = <div key="sidebar" className="explore-sidebar-inner">
    <h2 className="sidebar-title"><SlidersHorizontal size={18} aria-hidden /> Filters</h2>
    <FilterGroup title="Category" current={f.category} href={(value) => hrefWith({ category: value || null })}
      options={CATEGORIES.map(([value, label]) => ({ value, label }))} />
    <FilterGroup title="Price" current={f.price} href={(value) => hrefWith({ price: value || null })}
      options={[{ value: '', label: 'Any price' }, ...Object.entries(EXPLORE_PRICES).map(([value, p]) => ({ value, label: p.label }))]} />
    <FilterGroup title="Delivery time" current={f.delivery} href={(value) => hrefWith({ delivery: value || null })}
      options={[{ value: '', label: 'Any time' }, ...Object.entries(EXPLORE_DELIVERY).map(([value, label]) => ({ value, label }))]} />
    <FilterGroup title="Availability" current={f.available ? '1' : ''} href={(value) => hrefWith({ available: value || null })}
      options={[{ value: '', label: 'All creators' }, { value: '1', label: 'Accepting orders' }]} />
    {data.niches.length > 0 && <div className="filter-group">
      <h3 id="filter-niche">Niche</h3>
      <form method="get" action="/explore">
        {hidden(['niche'])}
        <Select name="niche" labelledBy="filter-niche" defaultValue={data.niches.includes(f.niche) ? f.niche : ''} autoSubmit
          options={[{ value: '', label: 'All niches' }, ...data.niches.map((niche) => ({ value: niche, label: niche }))]} />
        <noscript><button className="button button-outline compact" type="submit">Apply</button></noscript>
      </form>
    </div>}
    <div className="sidebar-actions">
      {active.length > 0 ? <Link className="button button-outline compact" href="/explore">Clear filters</Link> : <span className="muted">No filters applied</span>}
    </div>
  </div>;

  const toolbar = <div key="toolbar" className="explore-toolbar">
    <p className="muted explore-count">
      {f.cursor ? `${data.matched} more ${data.matched === 1 ? 'service' : 'services'}` : `${data.matched} ${data.matched === 1 ? 'service' : 'services'}`}
    </p>
    {active.length > 0 && <ul className="active-filters" aria-label="Active filters">
      {active.map((chip) => <li key={chip.label}><Link href={chip.href} aria-label={`Remove filter ${chip.label}`}>{chip.label} <span aria-hidden="true">×</span></Link></li>)}
      <li><Link className="text-link" href="/explore">Clear all</Link></li>
    </ul>}
    <form method="get" action="/explore" className="explore-sort">
      {hidden(['sort'])}
      <span className="muted" id="sort-label">Sort by</span>
      <Select name="sort" labelledBy="sort-label" variant="pill" defaultValue={f.sort} autoSubmit options={sorts.map(([value, label]) => ({ value, label }))} />
      <noscript><button className="button button-outline compact" type="submit">Apply</button></noscript>
    </form>
  </div>;

  return <main className="container explore-page">
    <Notices query={query} />
    <div className="explore-head">
      <PageHeading eyebrow="Explore" title="Find creators for your launch." />
      {/* A creator browsing the market can put their own offer on it without leaving: the form opens over this page. */}
      {actor && isCreator(actor) && <Link className="button button-dark explore-create" href="/creator/services/new" scroll={false}>
        <Plus size={16} aria-hidden /> Create a service
      </Link>}
    </div>
    <form method="get" action="/explore" className="explore-search" role="search">
      {hidden(['q', 'sort'])}
      <label className="explore-query">
        <Search size={18} aria-hidden />
        <input name="q" aria-label="Search services" defaultValue={f.q} placeholder="Explainer thread, research, launch copy…" />
      </label>
      <button className="button" type="submit">Search</button>
    </form>
    {data.error && <p className="notice">{data.error} Showing the newest services instead.</p>}

    <ExploreBrowser
      key={`${f.q}|${f.category}|${f.price}|${f.delivery}|${f.niche}|${f.available}|${f.sort}|${f.cursor}`}
      items={items}
      initialSelected={f.selected}
      sidebar={sidebar}
      toolbar={toolbar}
      filterCount={active.length}
      empty={<Empty key="empty" title="No services match these filters">
        Try fewer filters or a broader search. <Link className="text-link" href="/explore">Clear all filters</Link>
      </Empty>}
      pager={(data.next_cursor || f.cursor) ? <nav key="pager" className="explore-pages" aria-label="Pages">
        {f.cursor ? <Link className="button button-outline" href={hrefWith({})}>‹ First page</Link> : <span />}
        {data.next_cursor ? <Link className="button button-outline" href={`${hrefWith({})}${hrefWith({}).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.next_cursor)}`}>Next page ›</Link> : null}
      </nav> : null}
    />
  </main>;
}
