import Link from 'next/link';
import type { ReactNode } from 'react';
import { Avatar } from './avatar';

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
/** Status words that deserve color; everything else (categories, roles, counts) stays neutral. */
const GOOD = new Set(['COMPLETED', 'APPROVED', 'FUNDED', 'RELEASED', 'SUCCEEDED', 'PAID', 'SETTLED', 'READY', 'VERIFIED', 'CLAIMED', 'FULFILLED', 'ACCEPTED']);
// Orange is for states that are stuck until someone acts; routine in-flight states (awaiting payment, delivered) stay neutral.
const WAITING = new Set(['REFUND_PENDING', 'NEEDS_ACTION', 'EXPIRY_RECONCILING', 'WINNER_PENDING_PAYMENT', 'PENDING_REVIEW']);
const BAD = new Set(['DISPUTED', 'FAILED', 'REJECTED', 'SUSPENDED', 'WINNER_DEFAULTED', 'QUARANTINED', 'INVALID']);

/** AWAITING_PAYMENT -> Awaiting payment; mixed-case text is left alone. */
export function humanize(value: string): string {
  if (value !== value.toUpperCase()) return value;
  const words = value.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toneOf(value: unknown): 'good' | 'waiting' | 'bad' | 'neutral' {
  const key = String(value ?? '').trim().toUpperCase().replaceAll(' ', '_');
  if (GOOD.has(key)) return 'good';
  if (WAITING.has(key)) return 'waiting';
  if (BAD.has(key)) return 'bad';
  return 'neutral';
}

export function Badge({
  children,
  tone
}: {
  children: ReactNode;
  tone?: 'good' | 'waiting' | 'bad' | 'neutral';
}) {
  const resolved = tone ?? (typeof children === 'string' ? toneOf(children) : 'neutral');
  const label = typeof children === 'string' ? humanize(children) : children;
  return <span className={`badge badge-${resolved}`}>
    {label}
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
  className = '',
  variant = 'primary'
}: {
  command: string;
  children?: ReactNode;
  values?: Record<string, string>;
  label: string;
  returnTo?: string;
  className?: string;
  /** primary = the one next action; secondary = alternatives; danger = cancels, disputes and other irreversible steps. */
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  return <form method="post" action="/api/commands" className={`command-form ${className}`}>
    <input type="hidden" name="command" value={command} />
    <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
    {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
    {" "}
    {Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
    {children}
    <button className={variant === 'primary' ? 'button' : variant === 'danger' ? 'button button-outline button-danger-outline' : 'button button-outline'} type="submit">
      {label}
      
    </button>
  </form>;
}

/** §6.1 rule 10: buyers see a status, never counts or a guessed reopening date. Green only when orders can be placed. */
export function availabilityLabel(status: unknown): { label: string; className: string; accepting: boolean } {
  if (status === 'ACCEPTING') return { label: 'Accepting orders', className: 'status-dot status-good', accepting: true };
  if (status === 'PAUSED') return { label: 'Paused', className: 'status-dot', accepting: false };
  if (status === 'SOLD_OUT') return { label: 'Sold out', className: 'status-dot', accepting: false };
  return { label: 'Not available', className: 'status-dot', accepting: false };
}

export function ServiceCard({
  service
}: {
  service: unknown;
  index?: number;
}) {
  const s = row(service);
  const days = Math.max(1, Math.ceil(num(s.turnaround_hours) / 24));
  const availability = availabilityLabel(s.availability_status);
  return <Link href={`/services/${str(s.id)}`} className="service-card">
    <div className="service-card-top">
      <Avatar name={s.creator_name} assetId={s.avatar_asset_id} size={28} />
      <span className="service-card-creator">
        <strong>{str(s.creator_name, 'Independent creator')}</strong>
        {s.niche ? <span>{str(s.niche)}</span> : null}
      </span>
      <span className="service-card-category">{str(s.taxonomy, 'CREATE').toLowerCase()}</span>
    </div>
    <h3>
      {str(s.title, 'Creative service')}
    </h3>
    <p>
      {str(s.description).slice(0, 140)}
    </p>
    <div className="service-bottom">
      <span className="service-price">
        {money(s.price_minor)}
      </span>
      <span className="service-meta">
        {days}
        {days === 1 ? ' day' : ' days'}
        {' · '}
        <span className={availability.className}>{availability.label}</span>
      </span>
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
            <Badge tone={toneOf(o.status)}>
              {humanize(str(o.status))}
            </Badge>
          </td>
          <td>
            {money(o.amount_minor)}
          </td>
          <td>
            {date(o.created_at)}
          </td>
          <td>
            <Link className="text-link" href={`/orders/${str(o.id)}`}>Open ›</Link>
          </td>
        </tr>)}
      </tbody>
    </table>
  </div> : <Empty title="Your next collaboration starts here">
  <Link href="/explore" className="text-link">Find a creator ›</Link>
</Empty>;
}
