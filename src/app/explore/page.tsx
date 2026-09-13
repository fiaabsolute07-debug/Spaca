import { getPublicData } from '@/lib/read-model';
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
        eyebrow="The marketplace"
        title="Find your kind of creative."
        description="Explore clear scopes, work samples, and creators with room for your project."
      />
      <form method="get" className="filters">
        <input
          aria-label="Search services"
          name="q"
          placeholder="Try launch writing, video, design…"
          defaultValue={str(query.q)}
        />
        <select aria-label="Category" name="category" defaultValue={str(query.category)}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c}>
            {c}
          </option>)}
        </select>
        <button className="button button-dark">Search ↗</button>
      </form>
      <p className="muted">
        {services.length}
        {" service"}
        {services.length !== 1 ? 's' : ''}
        {" found · all with 0% platform fees"}
      </p>
      {services.length ? <div className="service-grid">
        {services.map((s, i) => <ServiceCard key={str(s.id)} service={s} index={i} />)}
      </div> : <Empty title="No matching services">Try another search or come back as creators publish new work.</Empty>}
    </>
  </main>;
}
