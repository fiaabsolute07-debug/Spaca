import Link from 'next/link';
import type { ReactNode } from 'react';

export type Row = Record<string, unknown>;
export const row = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
export const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
export const str = (value: unknown, fallback = '') => value == null ? fallback : String(value);
export const num = (value: unknown) => Number(value || 0);
export const money = (value: unknown) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(num(value) / 100);
export const date = (value: unknown) => value ? new Date(String(value)).toLocaleString('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC'
}) + ' UTC' : 'Not scheduled';
export function Badge({
  children
}: {
  children: ReactNode;
}) {
  return <span className="badge">
    {children}
  </span>;
}

export function Empty({
  title = 'Nothing here yet',
  children
}: {
  title?: string;
  children?: ReactNode;
}) {
  return <div className="empty">
    <span className="empty-symbol">↗</span>
    <h3>
      {title}
    </h3>
    <p>
      {children || 'Your activity will appear here as you get started.'}
    </p>
  </div>;
}

export function Field({
  name,
  label,
  type = 'text',
  required = false,
  value,
  placeholder,
  children
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  value?: string;
  placeholder?: string;
  children?: ReactNode;
}) {
  return <label className="field">
    <span>
      {label}
    </span>
    {children || (type === 'textarea' ? (
      <textarea
        name={name}
        required={required}
        defaultValue={value}
        placeholder={placeholder}
        rows={4}
      />
    ) : (
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={value}
        placeholder={placeholder}
      />
    ))}
  </label>;
}

export function CommandForm({
  command,
  children,
  values = {},
  label,
  returnTo,
  className = ''
}: {
  command: string;
  children?: ReactNode;
  values?: Record<string, string>;
  label: string;
  returnTo?: string;
  className?: string;
}) {
  return <form method="post" action="/api/commands" className={`command-form ${className}`}>
    <input type="hidden" name="command" value={command} />
    <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
    {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
    {" "}
    {Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
    {children}
    <button className="button" type="submit">
      {label}
      <span aria-hidden>↗</span>
    </button>
  </form>;
}

export function ServiceCard({
  service,
  index = 0
}: {
  service: unknown;
  index?: number;
}) {
  const s = row(service);
  return <Link href={`/services/${str(s.id)}`} className="service-card">
    <div className={`service-art art-${index % 4}`}>
      <span className="art-category">
        {str(s.taxonomy, 'CREATE')}
      </span>
      <div className="art-glyph">
        {['Aa', '▶', '✳', '↗'][index % 4]}
      </div>
      <span className="art-label">
        {str(s.platform, 'Independent creativity')}
      </span>
    </div>
    <div className="service-info">
      <div className="creator-line">
        <span className="avatar small">
          {str(s.creator_name, 'C').slice(0, 1)}
        </span>
        {str(s.creator_name, 'Independent creator')}
        <span className="dot" />
      </div>
      <h3>
        {str(s.title, 'Creative service')}
      </h3>
      <p>
        {str(s.description).slice(0, 120)}
      </p>
      <div className="service-bottom">
        <strong>
          {money(s.price_minor)}
        </strong>
        <span>
          {Math.ceil(num(s.turnaround_hours) / 24)}
          {" day delivery"}
        </span>
      </div>
      <div className="capacity-line">
        {num(s.available_units)}
        {" slots available · 0% platform fee"}
      </div>
    </div>
  </Link>;
}

export function OrderList({
  orders
}: {
  orders: unknown;
}) {
  const list = rows(orders);
  return list.length ? <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th>Status</th>
          <th>Amount</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map(o => <tr key={str(o.id)}>
          <td>
            <strong>
              {str(o.title, 'Creative order')}
            </strong>
            <small>
              #
              {str(o.id).slice(0, 8)}
            </small>
          </td>
          <td>
            <Badge>
              {str(o.status).replaceAll('_', ' ')}
            </Badge>
          </td>
          <td>
            {money(o.amount_minor)}
          </td>
          <td>
            {date(o.created_at)}
          </td>
          <td>
            <Link className="text-link" href={`/orders/${str(o.id)}`}>Open ↗</Link>
          </td>
        </tr>)}
      </tbody>
    </table>
  </div> : <Empty title="Your next collaboration starts here">
  <Link href="/explore" className="text-link">Find a creator →</Link>
</Empty>;
}
