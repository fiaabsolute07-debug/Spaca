import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { isBuyer } from '@/lib/account';
import { getGoalPageData } from '@/lib/read-model';
import { Notices } from '@/components/notices';
import { CampaignBoard } from '@/components/campaign/campaign-board';
import { ServiceCard, money, num, rows, str } from '@/components/ui';
import { GoalIcon } from '@/components/campaign/goal-icon';
import { GoalArt } from '@/components/campaign/goal-art';
import { GoalTabs } from '@/components/campaign/goal-tabs';
import type { PageProps } from '@/components/page-props';
import { CAMPAIGN_GOALS, goalBySlug } from '@/modules/requests/goals';
import { GOAL_PAGES } from '@/modules/requests/goal-pages';

export const dynamic = 'force-dynamic';

const shortDate = (time: number) => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The four figures at the head of a tab, each read straight off the campaigns that are open right now. A figure the
 * data cannot answer -- a per-creator cap nobody set, a closing date nobody gave -- is left out rather than invented.
 */
function factsFor(open: Record<string, unknown>[]): [string, string][] {
  if (!open.length) return [];
  const spots = open.reduce((total, request) => total + Math.max(0, num(request.target_hires) - num(request.hired_count)), 0);
  const caps = open.map((request) => num(request.per_creator_cap_minor)).filter((cap) => cap > 0);
  const closings = open
    .map((request) => (request.application_deadline ? new Date(String(request.application_deadline)).getTime() : NaN))
    .filter((time) => Number.isFinite(time));
  return [
    ['Open campaigns', String(open.length)],
    ['Spots open', String(spots)],
    ...(caps.length ? [['Lowest per creator', money(Math.min(...caps))] as [string, string]] : []),
    ...(closings.length ? [['Closes first', shortDate(Math.min(...closings))] as [string, string]] : []),
  ];
}

/**
 * One campaign tab. A tab never reads as empty: its idea, how the campaign works and what creators deliver are always
 * there, real creators who sell the matching kind of work are listed, and when no campaign is open the space invites
 * the first brief and points to the tabs that do have campaigns. Nothing on the page is an invented campaign.
 */
export default async function CampaignGoalPage({ params, searchParams }: PageProps<{ goal: string }>) {
  const query = await searchParams;
  const { goal: slug } = await params;
  const goal = goalBySlug(slug);
  if (!goal || goal.slug !== slug) notFound();
  const page = GOAL_PAGES[goal.value];
  const actor = await getActor();
  const creatorAccount = !!actor && !isBuyer(actor);
  const data = await getGoalPageData(goal.value, goal.taxonomy);
  const open = rows(data.requests);
  const facts = factsFor(open);
  const postHref = `/buyer/requests/new?goal=${goal.slug}`;
  const elsewhere = CAMPAIGN_GOALS.filter((other) => other.value !== goal.value && (data.goal_counts[other.value] ?? 0) > 0);

  return <main className="container">
    <Notices query={query} />
    <GoalTabs current={goal.value} counts={data.goal_counts} />

    <section className="goal-hero" aria-labelledby="goal-heading">
      <div className="goal-hero-text">
        <p className="goal-eyebrow"><GoalIcon goal={goal.value} size={14} /> {goal.title} campaigns</p>
        <h1 id="goal-heading">{page.headline}</h1>
        <p className="goal-pitch">{page.pitch}</p>
        <div className="inline-actions">
          {creatorAccount
            ? <Link className="button button-dark" href="#open-campaigns">See open {goal.title} campaigns</Link>
            : <Link className="button button-dark" href={postHref}>Post your {goal.title} brief</Link>}
          <Link className="button" href={`/explore?category=${goal.taxonomy}`}>Find creators</Link>
        </div>
      </div>
      {facts.length
        ? <div className="goal-facts">
          {facts.map(([label, value]) => <div key={label} className="goal-fact"><b>{value}</b><span>{label}</span></div>)}
        </div>
        : <div className="goal-hero-art"><GoalArt goal={goal.value} /></div>}
    </section>

    <section className="goal-section" aria-labelledby="how-heading">
      <div className="section-heading"><h2 id="how-heading">How {goal.title} campaigns work</h2></div>
      <ol className="goal-steps" aria-labelledby="how-heading">
        {page.steps.map(([title, text], index) => <li key={title}>
          <span className="goal-step-number">{index + 1}</span>
          <strong>{title}</strong>
          <small>{text}</small>
        </li>)}
      </ol>
    </section>

    <section className="goal-section" id="open-campaigns" aria-labelledby="open-heading">
      <div className="section-heading">
        <h2 id="open-heading">Open {goal.title} campaigns <span className="goal-count">{open.length}</span></h2>
        <Link className="text-link" href="/requests">All campaigns ›</Link>
      </div>
      {open.length ? <CampaignBoard items={open} label={`Open ${goal.title} campaigns`} /> : <div className="goal-empty">
        <div>
          <h3>No {goal.title} campaign is taking applications yet</h3>
          <p className="muted">{creatorAccount
            ? 'New briefs appear here as soon as a project posts one. Meanwhile, the other tabs below have open work.'
            : 'Yours would be the first one creators see here. The form is set up for this kind of campaign.'}</p>
          {!creatorAccount && <Link className="button button-dark" href={postHref}>Post the first {goal.title} brief</Link>}
        </div>
        <GoalArt goal={goal.value} />
        {elsewhere.length > 0 && <nav aria-label="Tabs with open campaigns" className="goal-elsewhere">
          <span className="muted">Open now in</span>
          {elsewhere.map((other) => <Link key={other.value} className="goal-chip" href={`/campaigns/${other.slug}`}>
            <GoalIcon goal={other.value} size={15} /> {other.title} <span className="goal-count">{data.goal_counts[other.value]}</span>
          </Link>)}
        </nav>}
      </div>}
    </section>

    <section className="goal-section" aria-labelledby="delivers-heading">
      <div className="section-heading"><h2 id="delivers-heading">What creators deliver</h2></div>
      <ul className="goal-delivers">
        {page.delivers.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <p className="muted">{page.rule}</p>
    </section>

    {rows(data.creators).length > 0 && <section className="goal-section" aria-labelledby="creators-heading">
      <div className="section-heading">
        <h2 id="creators-heading">Creators who sell this kind of work</h2>
        <Link className="text-link" href={`/explore?category=${goal.taxonomy}`}>See all ›</Link>
      </div>
      <div className="service-grid">
        {rows(data.creators).map((service, index) => <ServiceCard key={str(service.id)} service={service} index={index} />)}
      </div>
    </section>}

    {rows(data.recent).length > 0 && <section className="goal-section" aria-labelledby="recent-heading">
      <div className="section-heading"><h2 id="recent-heading">Recently filled or closed</h2></div>
      <CampaignBoard items={data.recent} label={`Recently filled or closed ${goal.title} campaigns`} />
    </section>}
  </main>;
}
