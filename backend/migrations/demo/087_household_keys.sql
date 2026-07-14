-- 087_household_keys.sql — Multi-tenant Phase 1 (b): widen natural/business keys to include
-- household_id so two households can hold the same username / category path / canonical name / etc.
-- Single-household semantics unchanged (every row is household 1). All widened keys are verified
-- NON-FK-targets, so no dependent FK breaks. Serial-PK tables need no widening (the serial already
-- namespaces globally). users.email stays GLOBALLY unique = the login identity; username per-household.

ALTER TABLE canonical_meta DROP CONSTRAINT canonical_meta_pkey;
ALTER TABLE canonical_meta ADD PRIMARY KEY (household_id, canonical_name);
ALTER TABLE canonical_translation DROP CONSTRAINT canonical_translation_pkey;
ALTER TABLE canonical_translation ADD PRIMARY KEY (household_id, canonical_name, lang);
ALTER TABLE canonical_alias DROP CONSTRAINT canonical_alias_pkey;
ALTER TABLE canonical_alias ADD PRIMARY KEY (household_id, ocr_key);
ALTER TABLE canonical_consumer DROP CONSTRAINT canonical_consumer_pkey;
ALTER TABLE canonical_consumer ADD PRIMARY KEY (household_id, canonical_name, family_member_id);
ALTER TABLE rejected_proposal DROP CONSTRAINT rejected_proposal_pkey;
ALTER TABLE rejected_proposal ADD PRIMARY KEY (household_id, ocr_key, proposed_canonical);
ALTER TABLE vorrat_override DROP CONSTRAINT vorrat_override_pkey;
ALTER TABLE vorrat_override ADD PRIMARY KEY (household_id, canonical_name);
ALTER TABLE vorschlag_snooze DROP CONSTRAINT vorschlag_snooze_pkey;
ALTER TABLE vorschlag_snooze ADD PRIMARY KEY (household_id, canonical_name);
ALTER TABLE artikel_ausschluss DROP CONSTRAINT artikel_ausschluss_pkey;
ALTER TABLE artikel_ausschluss ADD PRIMARY KEY (household_id, canonical_name);
ALTER TABLE einkaufsliste DROP CONSTRAINT einkaufsliste_pkey;
ALTER TABLE einkaufsliste ADD PRIMARY KEY (household_id, canonical_name);
ALTER TABLE merchant_konto DROP CONSTRAINT merchant_konto_pkey;
ALTER TABLE merchant_konto ADD PRIMARY KEY (household_id, merchant_key);

ALTER TABLE users DROP CONSTRAINT users_username_key;
ALTER TABLE users ADD CONSTRAINT users_household_username_key UNIQUE (household_id, username);
ALTER TABLE family_member DROP CONSTRAINT family_member_name_key;
ALTER TABLE family_member ADD CONSTRAINT family_member_household_name_key UNIQUE (household_id, name);
ALTER TABLE category DROP CONSTRAINT category_path_key;
ALTER TABLE category ADD CONSTRAINT category_household_path_key UNIQUE (household_id, path);
ALTER TABLE spending_goal DROP CONSTRAINT spending_goal_category_path_year_month_key;
ALTER TABLE spending_goal ADD CONSTRAINT spending_goal_household_key UNIQUE (household_id, category_path, year, month);
ALTER TABLE imported_file DROP CONSTRAINT imported_file_file_hash_key;
ALTER TABLE imported_file ADD CONSTRAINT imported_file_household_hash_key UNIQUE (household_id, file_hash);

-- store_branch: per-household branch list. Widen the (kind,name) unique index AND the trigger's
-- ON CONFLICT in lockstep, else einkauf INSERT raises 42P10 the moment the index changes (flag-off!).
DROP INDEX IF EXISTS ux_store_branch_kind_name;
CREATE UNIQUE INDEX ux_store_branch_household_kind_name ON store_branch (household_id, kind, name);

CREATE OR REPLACE FUNCTION public.link_store_branch()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_kind TEXT;
  v_name TEXT;
  v_id   INT;
BEGIN
  v_name := NULLIF(btrim(NEW.roh_ladenname), '');
  IF NEW.quelle = 'bar' OR v_name IS NULL THEN
    NEW.branch_id := NULL;
    RETURN NEW;
  END IF;
  v_kind := CASE WHEN NEW.quelle = 'email' THEN 'shop' ELSE 'filiale' END;
  -- scope the lookup + create to the receipt's household (NEW.household_id is populated by the
  -- column default before this BEFORE trigger runs; = 1 single-household, = current household in demo)
  SELECT id INTO v_id FROM store_branch
    WHERE household_id = NEW.household_id AND kind = v_kind AND name = v_name;
  IF v_id IS NULL THEN
    INSERT INTO store_branch (household_id, chain_key, name, kind)
    VALUES (NEW.household_id, normalize_store(v_name), v_name, v_kind)
    ON CONFLICT (household_id, kind, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_id;
  END IF;
  NEW.branch_id := v_id;
  RETURN NEW;
END;
$function$;
