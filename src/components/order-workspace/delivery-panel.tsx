import { Badge, CommandForm, Field, date, str, type Row } from '../ui';

export function OrderDeliveryPanel({
  order: o,
  delivery,
  creator,
  route
}: {
  order: Row;
  delivery: Row[];
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
      {Boolean(item.url) && <a className="text-link" href={str(item.url)} target="_blank" rel="noreferrer">Open attachment ↗</a>}
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
        placeholder="The delivered content, or where to find it and usage notes (a link or at least 20 characters)."
      />
      <Field name="url" label="Optional file or link" placeholder="https://…" />
    </CommandForm>}
  </div>;
}
