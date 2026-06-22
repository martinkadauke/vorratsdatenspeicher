-- A receipt line with no quantity almost always means exactly one item. New line
-- items now default menge to 1 at ingestion; normalize the existing blank ones too
-- so the stored data is consistent (the consumption/comparison logic already treats
-- a quantity-less line as 1 unit, so this changes stored data, not any estimate).
UPDATE artikel SET menge = 1 WHERE menge IS NULL;
