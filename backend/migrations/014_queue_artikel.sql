-- Link each verification-queue entry back to the specific artikel that
-- triggered it, so the review UI can jump to the receipt and highlight the item.
ALTER TABLE verifikations_queue ADD COLUMN IF NOT EXISTS artikel_id INT REFERENCES artikel(id) ON DELETE SET NULL;
