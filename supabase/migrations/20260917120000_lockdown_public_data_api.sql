-- Lock down the PostgREST Data API for DentaFlow OS.
-- Staff handlers use the server pg pool as postgres (BYPASSRLS). They keep
-- full access. anon / authenticated must not read or mutate public tables.
--
-- Local Docker has no anon/authenticated/supabase_admin roles; those steps
-- are skipped. ENABLE ROW LEVEL SECURITY still runs; table owners bypass RLS
-- unless FORCE is set (it is not).

DO $$
DECLARE
  r record;
  has_anon boolean;
  has_authenticated boolean;
BEGIN
  has_anon := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');

  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      r.schema_name,
      r.table_name
    );

    IF has_anon AND has_authenticated THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS deny_client_roles ON %I.%I',
        r.schema_name,
        r.table_name
      );
      EXECUTE format(
        'CREATE POLICY deny_client_roles ON %I.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        r.schema_name,
        r.table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON TABLES FROM anon, authenticated;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON SEQUENCES FROM anon, authenticated;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
    END IF;
  END IF;
END $$;
