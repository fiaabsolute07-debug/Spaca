import { DownloadButton } from '../digital/download-button';
import { CommandForm, Field, date, num, row, rows, str, type Row } from '../ui';

const LICENSE_TEXT: Record<string, string> = { EXCLUSIVE: 'Exclusive license', NON_EXCLUSIVE: 'Non-exclusive license' };
const kb = (bytes: unknown) => `${Math.max(1, Math.round(num(bytes) / 1024))} KB`;

/** XPL-06: the files this purchase includes, the download allowance and the refund-before-download option. */
export function OrderDigitalPanel({ order: o, digital, buyer, route }: { order: Row; digital: Row; buyer: boolean; route: string }) {
  const entitlement = row(digital.entitlement);
  const releases = rows(digital.releases);
  const terms = row(row(o.terms).digital);
  const active = str(entitlement.state) === 'ACTIVE';
  const used = num(entitlement.download_count);
  const limit = num(entitlement.download_limit);
  const canRefund = buyer && active && used === 0 && str(o.status) === 'DELIVERED' && (!o.review_due_at || new Date(str(o.review_due_at)).getTime() > Date.now());

  return <div className="panel digital-panel">
    <h2>Files for this purchase</h2>
    <ul className="facts">
      <li><span>License</span><strong>{LICENSE_TEXT[str(entitlement.license)] ?? str(entitlement.license)}</strong></li>
      <li><span>Updates</span><strong>{str(entitlement.updates_policy) === 'LATEST' ? 'Every new version' : `Version ${num(entitlement.release_version)} and earlier`}</strong></li>
      <li><span>Downloads</span><strong>{used} of {limit} used</strong></li>
    </ul>
    <p className="prewrap muted">{str(terms.rights_text)}</p>
    {!active && <p className="notice">{str(entitlement.state) === 'REVOKED' ? 'This purchase was cancelled or refunded, so the files are no longer available.' : 'The files unlock once payment is confirmed.'}</p>}
    {active && buyer && (releases.length ? releases.map((release) => <div className="record" key={str(release.version)}>
      <div className="inline-actions">
        <strong>Version {num(release.version)}</strong>
        <span className="muted">{str(release.filename)} · {kb(release.size_bytes)} · {date(release.created_at)}</span>
      </div>
      {release.notes ? <p className="prewrap">{str(release.notes)}</p> : null}
      {release.available
        ? used < limit ? <DownloadButton entitlementId={str(entitlement.id)} version={num(release.version)} label={`Download version ${num(release.version)}`} /> : <p className="muted">Download limit reached.</p>
        : <p className="muted">Held for a safety review.</p>}
    </div>) : <p className="muted">No file is available yet.</p>)}
    {!buyer && <p className="muted">The buyer downloads the files from here. {used > 0 ? `First downloaded ${date(entitlement.first_downloaded_at)}.` : 'Not downloaded yet.'}</p>}
    {canRefund && <CommandForm variant="danger" command="refund_digital_purchase" label="Cancel before downloading" values={{ order_id: str(o.id) }} returnTo={route}>
      <p className="muted">You have not downloaded the files, so you can cancel for a full refund until {date(o.review_due_at)}. The files will no longer be available.</p>
      <Field name="reason" label="Reason (optional)" type="textarea" />
    </CommandForm>}
    {buyer && active && used > 0 && <p className="muted">The files were downloaded, so the purchase can no longer be cancelled on its own. Open a dispute if they are not as described.</p>}
  </div>;
}
