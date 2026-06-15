-- Least-privilege Postgres role for the read-only Analytics agent.
--
-- TOP DIRECTIVE: the Analytics agent may run powerful reads but must NEVER be
-- able to write or delete — not even close. This role is layer 1 of the
-- defense-in-depth: the app connects as the cluster owner, but every analytics
-- query runs via `SET LOCAL ROLE analytics` inside a READ ONLY transaction
-- (see db.ts analyticsRead). Even a buggy or LLM-shaped query physically cannot
-- mutate data, because this role only ever holds SELECT.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics') THEN
    CREATE ROLE analytics
      NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Allow the connecting app role to assume `analytics` via SET ROLE. A superuser
-- can already SET ROLE to anything; this matters only on non-superuser clusters.
DO $$
BEGIN
  EXECUTE format('GRANT analytics TO %I', current_user);
EXCEPTION WHEN others THEN
  NULL;  -- already a member, or managed cluster restricts it — SET ROLE still works for superusers
END
$$;

-- Read-only surface for everything that exists today.
GRANT USAGE  ON SCHEMA public                TO analytics;
GRANT SELECT ON ALL TABLES    IN SCHEMA public TO analytics;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO analytics;

-- Auto-grant SELECT on objects created by LATER migrations (tables AND views).
-- Must run BEFORE those objects are created — migration order (039 < 040…) guarantees it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES    TO analytics;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO analytics;

-- Belt and braces: ensure no write privilege ever leaks to the role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM analytics;
