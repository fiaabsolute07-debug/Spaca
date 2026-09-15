import Link from 'next/link';
import { Search } from 'lucide-react';
import { EXPLORE_DELIVERY, EXPLORE_PRICES, EXPLORE_SORTS, getExploreData } from '@/lib/read-model';
import { Select } from '@/components/select';
import { Empty, rows } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { ExploreBrowser } from '@/components/explore/explore-browser';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  { value: 'CREATE', label: 'Create' },
  { value: 'PUBLISH', label: 'Publish' },
  { value: 'ACCESS', label: 'Access' },
  { value: 'DIGITAL', label: 'Digital' },
];

export default async function ExplorePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const data = await getExploreData(query);
  const f = data.filters;
  const items = rows(data.items);

  // Links keep every filter except the ones being changed; the cursor never survives a filter change.
  const hrefWith = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const base: Record<string, string> = { q: f.q, category: f.category, niche: f.niche, price: f.price, delivery: f.delivery, available: f.available ? '1' : '', sort: f.sort };
    for (const [key, value] of Object.entries({ ...base, ...changes })) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `/explore?${text}` : '/explore';
  };
  const active = [
    f.q && { label: `“${f.q}”`, href: hrefWith({ q: null, sort: null }) },
    f.category && { label: CATEGORY_OPTIONS.find((c) => c.value === f.category)!.label, href: hrefWith({ category: null }) },
    f.price && { label: EXPLORE_PRICES[f.price]!.label, href: hrefWith({ price: null }) },
    f.delivery && { label: EXPLORE_DELIVERY[f.delivery]!, href: hrefWith({ delivery: null }) },
    f.niche && { label: f.niche, href: hrefWith({ niche: null }) },
    f.available && { label: 'Accepting orders', href: hrefWith({ available: null }) },
  ].filter(Boolean) as { label: string; href: string }[];
  const sorts = Object.entries(EXPLORE_SORTS).filter(([value]) => value !== 'relevance' || f.q);

  return <main className="container explore-page">
    <Notices query={query} />
    <PageHeading eyebrow="Explore" title="Find creators for your launch." />
    <form method="get" action="/explore" className="explore-form" role="search">
      <div className="explore-search">
        <Select name="category" ariaLabel="Category" variant="pill" defaultValue={f.category} options={CATEGORY_OPTIONS} autoSubmit />
        <label className="explore-query">
          <Search size={18} aria-hidden />
          <input name="q" aria-label="Search services" defaultValue={f.q} placeholder="Explainer thread, research, launch copy…" />
        </label>
        <button className="button" type="submit">Search</button>
      </div>
      <div className="explore-filters" aria-label="Filters">
        <Select name="price" ariaLabel="Price" variant="pill" defaultValue={f.price} autoSubmit
          options={[{ value: '', label: 'Any price' }, ...Object.entries(EXPLORE_PRICES).map(([value, p]) => ({ value, label: p.label }))]} />
        <Select name="delivery" ariaLabel="Delivery time" variant="pill" defaultValue={f.delivery} autoSubmit
          options={[{ value: '', label: 'Any delivery time' }, ...Object.entries(EXPLORE_DELIVERY).map(([value, label]) => ({ value, label }))]} />
        {data.niches.length > 0 && <Select name="niche" ariaLabel="Niche" variant="pill" defaultValue={data.niches.includes(f.niche) ? f.niche : ''} autoSubmit
          options={[{ value: '', label: 'All niches' }, ...data.niches.map((niche) => ({ value: niche, label: niche }))]} />}
        {f.available && <input type="hidden" name="available" value="1" />}
        {/* A link, so the filter works before scripts load; it keeps the other filters. */}
        <Link className={`filter-toggle${f.available ? ' is-on' : ''}`} href={hrefWith({ available: f.available ? null : '1' })} role="switch" aria-checked={f.available}>
          <span className="filter-check" aria-hidden="true">{f.available ? '✓' : ''}</span>
          Accepting orders
        </Link>
        <span className="explore-sort">
          <span className="muted">Sort</span>
          <Select name="sort" ariaLabel="Sort" variant="pill" defaultValue={f.sort} autoSubmit options={sorts.map(([value, label]) => ({ value, label }))} />
        </span>
        <noscript><button className="button button-outline" type="submit">Apply filters</button></noscript>
      </div>
    </form>

    {data.error && <p className="notice">{data.error} Showing the newest services instead.</p>}
    <div className="explore-summary">
      <p className="muted">
        {f.cursor ? `${data.matched} more ${data.matched === 1 ? 'service' : 'services'}` : `${data.matched} ${data.matched === 1 ? 'service' : 'services'}`}
      </p>
      {active.length > 0 && <ul className="active-filters" aria-label="Active filters">
        {active.map((chip) => <li key={chip.label}><Link href={chip.href} aria-label={`Remove filter ${chip.label}`}>{chip.label} <span aria-hidden="true">×</span></Link></li>)}
        <li><Link className="text-link" href="/explore">Clear all</Link></li>
      </ul>}
    </div>

    {items.length
      ? <ExploreBrowser key={`${f.q}|${f.category}|${f.price}|${f.delivery}|${f.niche}|${f.available}|${f.sort}|${f.cursor}`} items={items} initialSelected={f.selected} />
      : <Empty title="No services match these filters">
          Try fewer filters or a broader search. <Link className="text-link" href="/explore">Clear all filters</Link>
        </Empty>}

    {(data.next_cursor || f.cursor) && <nav className="explore-pages" aria-label="Pages">
      {f.cursor ? <Link className="button button-outline" href={hrefWith({})}>‹ First page</Link> : <span />}
      {data.next_cursor ? <Link className="button button-outline" href={`${hrefWith({})}${hrefWith({}).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.next_cursor)}`}>Next page ›</Link> : null}
    </nav>}
  </main>;
}
