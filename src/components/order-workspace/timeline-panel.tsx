import { date, str, type Row } from '../ui';

export function OrderTimelinePanel({
  events
}: {
  events: Row[];
}) {
  return <div className="panel">
    <h2>Timeline</h2>
    {events.length ? <div className="timeline">
      {events.map(event => <div className="timeline-item" key={str(event.id)}>
        <strong>
          {str(event.kind).replaceAll('_', ' ')}
        </strong>
        <p>
          {date(event.created_at)}
        </p>
      </div>)}
    </div> : <p className="muted">No events yet.</p>}
  </div>;
}
