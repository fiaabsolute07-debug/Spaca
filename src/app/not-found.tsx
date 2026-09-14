import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="container error-page">
      <div className="eyebrow">404 · Not found</div>
      <h1>That page has moved on.</h1>
      <p className="muted">Explore the marketplace or open your workspace to continue.</p>
      <div className="inline-actions">
        <Link className="button button-dark" href="/explore">Find creators</Link>
        <Link className="button button-outline" href="/dashboard">Open workspace</Link>
      </div>
    </main>
  );
}
