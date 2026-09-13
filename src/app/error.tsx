'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="container error-page">
      <div className="eyebrow">Something needs a second look.</div>
      <h1>We could not load this workspace.</h1>
      <p className="muted">Your work is kept behind the same authorization checks. Try again, or return to the marketplace.</p>
      <div className="inline-actions">
        <button className="button button-dark" onClick={() => reset()}>Try again ↗</button>
        <a className="button button-outline" href="/">Back to marketplace</a>
      </div>
    </main>
  );
}
