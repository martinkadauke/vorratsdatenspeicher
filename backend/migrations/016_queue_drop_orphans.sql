-- Drop stale queue entries that couldn't be linked to any current artikel
-- (orphans from before the receipt re-import — their ai_examples no longer
-- match any artikel, so they're unactionable: even "approve" would update 0
-- rows). Future churns create fresh, properly-linked entries.
DELETE FROM verifikations_queue WHERE artikel_id IS NULL AND status = 'pending';
