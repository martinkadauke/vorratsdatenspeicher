-- Account type per konto: the NATURE of the account (Girokonto, Kreditkarte,
-- Bargeld, Krypto, Depot, PayPal), distinct from the older `payment_type`
-- ("how you pay", collected in onboarding, unused elsewhere and NULL in practice).
--
-- Drives receipt completeness: only Girokonto & Kreditkarte have importable bank
-- statements (comdirect-style CSV), so a receipt on one of those must have a linked
-- bank booking to count as complete; receipts on Bargeld/Krypto/Depot/PayPal do not.
--
-- Additive (not a RENAME of payment_type) on purpose: during a rolling deploy the old
-- replicas still SELECT payment_type, so the column must stay. New code reads
-- account_type; payment_type is left as a harmless legacy column.
ALTER TABLE konto ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'giro';

-- Backfill from existing signals (guard on the default so re-runs are idempotent):
UPDATE konto SET account_type = 'bargeld'     WHERE account_type = 'giro' AND is_cash;
UPDATE konto SET account_type = 'kreditkarte' WHERE account_type = 'giro' AND NOT is_cash AND payment_type = 'kreditkarte';
UPDATE konto SET account_type = 'paypal'      WHERE account_type = 'giro' AND NOT is_cash AND payment_type = 'paypal';
UPDATE konto SET account_type = 'bargeld'     WHERE account_type = 'giro' AND payment_type = 'bar';
-- 'karte' (generic debit card) and NULL payment_type stay 'giro' (the default).
