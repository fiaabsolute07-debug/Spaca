import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Actor } from '@/lib/auth';
import { OperatorAccessError } from '@/modules/admin/queries';
import type { Query } from '@/components/page-props';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CommandForm, Field, str, type Row } from '@/components/ui';
import { AdminNav } from './admin-nav';

// All operator reads pass through the backend's authorization, including empty searches.
export async function operatorRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OperatorAccessError) notFound();
    throw error;
  }
}

export function AdminPage({ actor, route, query, title, description, children }: {
  actor: Actor;
  route: string;
  query: Query;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <main className="container admin-console">
    <Link className="text-link" href="/dashboard">← Workspace</Link>
    <PageHeading eyebrow="Operator console · 0% platform fee" title={title} description={description} />
    <AdminNav actor={actor} route={route} />
    <Notices query={query} />
    {children}
  </main>;
}

export function AdminCommand({ command, route, values, label, children }: {
  command: string;
  route: string;
  values: Record<string, string>;
  label: string;
  children?: ReactNode;
}) {
  return <CommandForm command={command} returnTo={route} values={values} label={label}>
    {children}
    <Field name="reason" label="Reason for the audit log (at least 10 characters)">
      <textarea name="reason" required minLength={10} maxLength={2000} rows={3} />
    </Field>
  </CommandForm>;
}

export function SelectField({ name, label, options, value }: {
  name: string;
  label: string;
  options: readonly string[];
  value?: string;
}) {
  return <Field name={name} label={label}>
    <select name={name} required defaultValue={value ?? options[0]}>
      {options.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}
    </select>
  </Field>;
}

export function OrderLink({ id }: { id: unknown }) {
  return id ? <Link className="text-link" href={`/admin/orders/${encodeURIComponent(str(id))}`}>
    Order #{str(id).slice(0, 8)} ↗
  </Link> : <span className="muted">No linked order</span>;
}

export function age(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 'Unknown';
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function listText(value: unknown): string {
  return Array.isArray(value) ? value.map(item => str(item)).join(', ') || 'None' : str(value, 'None');
}

export function queryText(value: Query[string]): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

// The backend redacts references; also mask short references that it passes through unchanged.
export function providerReference(value: unknown): string {
  const reference = str(value);
  if (!reference) return 'None';
  return reference.length > 4 ? `…${reference.slice(-4)}` : '[redacted]';
}

// Audit snapshots are structured operational state. Never expose content or URL/reference fields.
export function compactAuditJson(value: unknown): string {
  return JSON.stringify(value ?? null, (key, item: unknown) => {
    if (/brief|delivery_text|body|payload|url|uri|reference|token|secret/i.test(key)) return '[redacted]';
    if (typeof item === 'string' && /https?:\/\//i.test(item)) return '[redacted URL]';
    return typeof item === 'bigint' ? item.toString() : item;
  });
}

export type Column = { label: string; render: (item: Row) => ReactNode };

export function AdminTable({ title, items, columns, id }: {
  title: string;
  items: readonly Row[];
  columns: readonly Column[];
  id?: string;
}) {
  return <section className="admin-section" id={id}>
    <h2>{title} <span className="muted">({items.length})</span></h2>
    {items.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label={title}>
      <table>
        <caption className="admin-sr-only">{title}</caption>
        <thead><tr>{columns.map(column => <th key={column.label} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>{items.map((item, index) => <tr key={`${str(item.id ?? item.operation_id ?? item.order_id)}-${index}`}>
          {columns.map(column => <td key={column.label}>{column.render(item)}</td>)}
        </tr>)}</tbody>
      </table>
    </div> : <p className="muted">No {title.toLowerCase()} are visible in this view.</p>}
  </section>;
}
