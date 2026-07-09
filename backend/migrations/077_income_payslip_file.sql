-- 077_income_payslip_file.sql
-- Persist the uploaded pay-slip file so it can be viewed later (previously the
-- buffer was OCR'd and discarded). Stored under a NON-static _payslips/ subdir of
-- the receipts volume and served ONLY via the auth-guarded
-- GET /api/finances/income/:id/file — salary docs, shared household finance data.
ALTER TABLE income ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE income ADD COLUMN IF NOT EXISTS file_name TEXT;
