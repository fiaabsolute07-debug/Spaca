-- The Funds page sums each account's order principal from the ledger. Neither ledger table was indexed on the column
-- that finds an order's transactions or a transaction's entries, so every read scanned both tables.
CREATE INDEX IF NOT EXISTS ledger_transactions_order_idx ON app.ledger_transactions (order_id);
CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx ON app.ledger_entries (transaction_id);
