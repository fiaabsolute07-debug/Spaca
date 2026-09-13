import { FileList } from '../files/file-list';
import { FileUploadField } from '../files/file-upload-field';
import { Badge, CommandForm, Field, date, str, type Row } from '../ui';

const attachedTo = (files: Row[], deliveryId: string) => files
  .map((file) => ({ file, link: (file.attachments as Row[] | undefined ?? []).find((a) => str(a.delivery_id) === deliveryId) }))
  .filter((entry) => entry.link)
  .sort((a, b) => Number(a.link!.position) - Number(b.link!.position))
  .map((entry) => entry.file);

export function OrderDeliveryPanel({
  order: o,
  delivery,
  files,
  creator,
  route
}: {
  order: Row;
  delivery: Row[];
  files: Row[];
  creator: boolean;
  route: string;
}) {
  return <div className="panel">
    <h2>Delivery</h2>
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
      <FileList files={attachedTo(files, str(item.id))} />
      {Boolean(item.url) && <a className="text-link" href={str(item.url)} target="_blank" rel="noreferrer">Open link ↗</a>}
    </div>) : <p className="muted">The creator has not delivered work yet.</p>}
    {creator && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(str(o.status)) && <CommandForm
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
