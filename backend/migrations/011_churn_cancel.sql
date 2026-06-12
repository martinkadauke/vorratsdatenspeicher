-- Cooperative cancel for long-running maintenance jobs. The stop endpoint
-- sets cancel_requested on the running event; the job loop polls it (cheap)
-- and bails out gracefully. DB-based so it works across Swarm replicas (the
-- stop request may hit a different replica than the one running the job).
ALTER TABLE maintenance_event ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
