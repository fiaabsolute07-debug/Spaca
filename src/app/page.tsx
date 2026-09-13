import Link from 'next/link';

import { getPublicData } from '@/lib/read-model';
import { Empty, ServiceCard, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function HomePage({
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
      <section className="hero">
        <div>
          <div className="eyebrow">
            <span className="dot" />
            Independent talent. Open for good work.
          </div>
          <h1>
            Your next big idea.
            <br />
            <em>The right creator.</em>
          </h1>
          <p>
            Find people who get your vision. Book their next available slot, agree on the
            details, and make something worth sharing.
          </p>
          <div className="hero-actions">
            <Link href="/explore" className="button button-dark">
              {"Find your creator "}
              <span>↗</span>
            </Link>
            <Link href="/sign-up?role=creator" className="button button-outline">Offer your skills</Link>
          </div>
          <span className="hero-note">Clear scope. Real availability. 0% platform fees.</span>
        </div>
        <div className="hero-art" aria-label="Creators keep 100% before third-party payment costs">
          <div className="hero-ring" />
          <div className="art-tag">Built around your craft ↗</div>
          <div className="floating-card">
            <div className="eyebrow">More room to create</div>
            <h3>
              Your work.
              <br />
              Your rate.
              <br />
              Your whole payment.
            </h3>
            <div className="fee">
              <span>Platform fee</span>
              <strong>0%</strong>
            </div>
            <p className="muted">Third-party costs, if any, are disclosed separately.</p>
          </div>
          <div className="big-star" aria-hidden>✳</div>
        </div>
      </section>
      <div className="value-strip">
        <div>
          <strong>01 / Find the right fit</strong>
          <p>Browse work samples and clear service scopes.</p>
        </div>
        <div>
          <strong>02 / Book actual availability</strong>
          <p>Reserve a creator’s available capacity.</p>
        </div>
        <div>
          <strong>03 / Make it happen</strong>
          <p>One shared space for briefs, delivery, and approval.</p>
        </div>
      </div>
      <div className="section-heading">
        <div>
          <div className="eyebrow">Ready for your next project</div>
          <h2>Good people. Great possibilities.</h2>
        </div>
        <Link className="text-link" href="/explore">Explore all ↗</Link>
      </div>
      {services.length ? <div className="service-grid">
        {services.slice(0, 6).map((s, i) => <ServiceCard key={str(s.id)} service={s} index={i} />)}
      </div> : (
        <Empty title="The marketplace is ready for its first creators">
          Create a service with work samples and real availability to get started.
        </Empty>
      )}
    </>
  </main>;
}
