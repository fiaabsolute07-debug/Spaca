-- BNK-01/02/03: buyer funding by bank transfer through the provider (policy bank-v1), off by default.
-- A bank transfer confirms asynchronously, often days later. The order is never funded on the buyer's word or a
-- screenshot, only on the provider's verified fact; the reservation uses its own longer hold; a transfer the bank
-- later returns is recorded as RETURNED and never released to the creator.

INSERT INTO app.feature_flags (key, enabled, description) VALUES
  ('BANK_FUNDING_ENABLED', false, 'Buyer funding by bank transfer (asynchronous, provider-managed, bank-v1 hold)')
ON CONFLICT (key) DO NOTHING;

-- How the captured payment was made; set from the provider operation when funding is confirmed.
ALTER TABLE app.orders ADD COLUMN funding_method text CHECK (funding_method IS NULL OR funding_method IN ('CARD','BANK_TRANSFER'));

ALTER TABLE app.orders DROP CONSTRAINT orders_payment_status_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','RETURNED'));
-- Only a bank-funded order can have its funds returned (coalesce: a NULL method must fail the check, not pass it).
ALTER TABLE app.orders ADD CONSTRAINT orders_returned_is_bank CHECK (payment_status <> 'RETURNED' OR coalesce(funding_method, '') = 'BANK_TRANSFER');
