import { FileList } from '../files/file-list';
import { FileUploadField } from '../files/file-upload-field';
import { Badge, CommandForm, Field, date, row, str, type Row } from '../ui';
import { ReportForm } from '../report-form';

const attachedTo = (files: Row[], deliveryId: string) => files
  .map((file) => ({ file, link: (file.attachments as Row[] | undefined ?? []).find((a) => str(a.delivery_id) === deliveryId) }))
  .filter((entry) => entry.link)
  .sort((a, b) => Number(a.link!.position) - Number(b.link!.position))
  .map((entry) => entry.file);

const channelName = (publish: Row) => publish.handle ? `@${str(publish.handle)} on ${platformName(str(publish.platform))}` : str(publish.channel_url);
const platformName = (platform: string) => ({ X: 'X', INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube', NEWSLETTER: 'newsletter', WEBSITE: 'website' } as Record<string, string>)[platform] ?? platform;

/** XPL-02: what the buyer approves on a PUBLISH order is the live post, checked against the sold channel. */
function PublishProof({ proof, publish, route }: { proof: Row; publish: Row; route: string }) {
  return <div className="publish-proof">
    <ul className="facts">
      <li><span>Post</span><a className="text-link" href={str(proof.post_url)} target="_blank" rel="noreferrer">Open post ›</a></li>
      <li><span>Went live</span><strong>{date(proof.published_at)}{proof.late ? ' · after the due date' : ''}</strong></li>
      <li><span>Channel</span><strong>{str(proof.link_check) === 'MATCHES_CHANNEL' ? `Link matches ${channelName(publish)}` : `Same platform (${platformName(str(proof.platform))} links do not show the account)`}</strong></li>
      <li><span>Disclosure</span><strong>“{str(proof.disclosure_text)}” confirmed by the creator</strong></li>
    </ul>
    <p className="muted">spaca checks the link, not the post. Open it to confirm the content and disclosure. It must stay live for {str(publish.min_live_hours)} hours.</p>
    <ReportForm targetType="PUBLISH_PROOF" targetId={str(proof.id)} returnTo={route} label="Report a problem with this post" />
  </div>;
}

export function OrderDeliveryPanel({
  order: o,
  delivery,
  files,
  creator,
  route,
  publishTerms,
  proofs = []
}: {
  order: Row;
  delivery: Row[];
  files: Row[];
  creator: boolean;
  route: string;
  publishTerms?: unknown;
  proofs?: Row[];
}) {
  const publish = publishTerms ? row(publishTerms) : null;
  return <div className="panel">
    <h2>{publish ? 'Published post' : 'Delivery'}</h2>
    {publish && <p className="muted">
      Posts on {channelName(publish)} as a {str(publish.format).replaceAll('_', ' ').toLowerCase()}, labelled “{str(publish.disclosure_text)}”, live for at least {str(publish.min_live_hours)} hours.
    </p>}
    {delivery.length ? delivery.map(item => <div className="record" key={str(item.id)}>
      <div className="inline-actions">
        <Badge>
          {"Version "}
          {str(item.version)}
        </Badge>
        <span className="muted">
          {date(item.created_at)}
          {item.buyer_viewed_at ? ' · opened by buyer' : ''}
        </span>
      </div>
      <p className="prewrap">
        {str(item.body)}
      </p>
      {publish && proofs.filter((proof) => str(proof.delivery_id) === str(item.id)).map((proof) => <PublishProof key={str(proof.id)} proof={proof} publish={publish} route={route} />)}
      <FileList files={attachedTo(files, str(item.id))} />
      {Boolean(item.url) && !publish && <a className="text-link" href={str(item.url)} target="_blank" rel="noreferrer">Open link ›</a>}
    </div>) : <p className="muted">The creator has not delivered work yet.</p>}
    {creator && publish && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(str(o.status)) && <CommandForm
      command="deliver"
      label="Submit the published post"
      values={{ order_id: str(o.id) }}
      returnTo={route}
    >
      <Field name="post_url" label={`Link to the post on ${channelName(publish)}`} required placeholder="https://x.com/yourname/status/…" />
      <Field name="published_at" label="When it went live (UTC)" type="datetime-local" required />
      <label className="field">
        <span><input type="checkbox" name="disclosure_attested" required /> The post shows “{str(publish.disclosure_text)}” and is written in my own words.</span>
      </label>
      <Field name="body" label="Note for the buyer (optional)" type="textarea" placeholder="Anything the buyer should know about the post." />
    </CommandForm>}
    {creator && !publish && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(str(o.status)) && <CommandForm
      command="deliver"
      label="Submit delivery"
      values={{
        order_id: str(o.id)
      }}
      returnTo={route}
    >
      <Field
        name="body"
        label="Delivery note"
        type="textarea"
        placeholder="Usage notes or the delivered text (a file, a link or at least 20 characters)."
      />
      <FileUploadField
        purpose="DELIVERY"
        orderId={str(o.id)}
        label="Files"
        help="Up to 10 files: images 10 MB, PDF/DOCX 25 MB, video 250 MB. Files are private to this order."
      />
      <Field name="url" label="Optional link" placeholder="https://…" />
    </CommandForm>}
  </div>;
}
