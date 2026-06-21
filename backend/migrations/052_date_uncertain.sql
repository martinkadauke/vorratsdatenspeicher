-- When OCR extracts a receipt's items + vendor + total but finds NO date (e.g. an
-- email order-confirmation screenshot), we keep the items and flag the date as
-- unconfirmed instead of discarding everything. The UI then requires the user to
-- enter the date before the receipt can be finalised (geprüft).
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS date_uncertain BOOLEAN NOT NULL DEFAULT FALSE;
