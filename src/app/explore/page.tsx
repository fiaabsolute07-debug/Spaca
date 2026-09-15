import { getPublicData } from '@/lib/read-model';
import { Select } from '@/components/select';
import { Empty, ServiceCard, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { categories } from '@/components/category-field';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function ExplorePage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  const notices = <Notices query={query} />;
  const data = await getPublicData({
    q: typeof query.q === 'string' ? query.q : undefined,
    category: typeof query.category === 'string' ? query.category : undefined
  });
  const services = rows(data.services);
  return <main className="container">
    {notices}
    <>
      <PageHeading
        eyebrow="Explore"
        title="Find creators for your launch."
        description="Crypto-native researchers, writers and analysts on X, with clear scopes and real work samples."
      />
      <form method="get" className="filters">
        <input
          aria-label="Search services"
          name="q"
          placeholder="Try explainer thread, research, launch copy…"
          defaultValue={str(query.q)}
        />
        <Select ariaLabel="Category" name="category" variant="pill" defaultValue={categories.includes(str(query.category)) ? str(query.category) : ''}
          options={[{ value: '', label: 'All categories' }, ...categories.map(c => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() }))]} />
        <button className="button">Search</button>
      </form>
      <p className="muted">
        {services.length}
        {" service"}
        {services.length !== 1 ? 's' : ''}
        {" found"}
      </p>
      {services.length ? <div className="service-grid">
        {services.map((s, i) => <ServiceCard key={str(s.id)} service={s} index={i} />)}
      </div> : <Empty title="No matching services">Try another search or come back as creators publish new work.</Empty>}
    </>
  </main>;
}
