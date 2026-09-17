import type { ReactNode } from 'react';

/**
 * Where a payment step would be while payments are not open (PAYMENT_MODE=off, the launch choice of 2026-09-17): says so
 * before anyone presses a button that would only refuse.
 */
export function PaymentsClosed({ title = 'Payments open later', children }: { title?: string; children: ReactNode }) {
  return <div className="payments-closed" role="note">
    <strong>{title}</strong>
    <p>{children}</p>
  </div>;
}
