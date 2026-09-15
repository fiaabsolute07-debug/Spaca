'use client';

import { useState } from 'react';

/** Asks the server for a 5-minute link on the buyer's entitlement (counted against the limit), then opens it. */
export function DownloadButton({ entitlementId, version, label }: { entitlementId: string; version: number; label: string }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  async function start() {
    setState({ busy: true, error: null });
    try {
      const response = await fetch(`/api/digital/entitlements/${entitlementId}/download-url`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ version }),
      });
      const body = await response.json() as { url?: string; error?: string };
      if (!response.ok || !body.url) return setState({ busy: false, error: body.error ?? 'The download could not start' });
      setState({ busy: false, error: null });
      window.location.assign(body.url);
    } catch {
      setState({ busy: false, error: 'Network error. Try again.' });
    }
  }
  return <span className="download-action">
    <button type="button" className="button button-outline" disabled={state.busy} onClick={start}>{state.busy ? 'Preparing…' : label}</button>
    {state.error && <span className="notice" role="alert">{state.error}</span>}
  </span>;
}
