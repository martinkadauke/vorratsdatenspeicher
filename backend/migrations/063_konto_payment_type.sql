-- Payment type per account (Bar / Karte / Kreditkarte / Paypal), collected in the
-- onboarding wizard and editable in Admin. Orthogonal to is_shared (shared vs personal).
ALTER TABLE konto ADD COLUMN IF NOT EXISTS payment_type TEXT;  -- 'bar' | 'karte' | 'kreditkarte' | 'paypal' | NULL

-- "GKK" (Gemeinkostenkonto) is jargon — the default shared account should read
-- "Haushaltskonto". Only touch the untouched seed name, never a user-renamed account.
UPDATE konto SET name = 'Haushaltskonto' WHERE name = 'GKK' AND is_shared = TRUE;
