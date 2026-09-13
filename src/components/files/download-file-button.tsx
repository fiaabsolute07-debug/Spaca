'use client';

import { useState } from 'react';

/** Asks the server for a fresh 5-minute URL on every click; signed URLs are never rendered into the page. */
export function DownloadFileButton({ assetId, label = 'Download' }: { assetId: string; label?: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function open() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/assets/${assetId}/download-url`, { method: 'POST', headers: { accept: 'application/json' } });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) setMessage(body.error ?? 'This file is not available');
      else window.location.assign(body.url);
    } catch {
      setMessage('Network error');
    } finally {
      setPending(false);
    }
  }

  return <span className="inline-actions">
    <button type="button" className="button button-outline compact" onClick={open} disabled={pending}>{pending ? 'Preparing…' : label}</button>
    {message && <span className="muted" role="status">{message}</span>}
  </span>;
}
