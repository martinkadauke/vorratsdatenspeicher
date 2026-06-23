-- Email receipts: the OCR sometimes lifted a wrong date out of the body (a delivery
-- estimate, a copyright year, a previous order), which overrode the reliable email
-- Date header — burying the receipt months/years off. Re-anchor such receipts to the
-- mail's sent date when the stored date is far (>21 days) from it. Skip forwards
-- (their header is the forward time, not the original invoice's).
UPDATE einkauf e
SET datum = em.sent_at::date, date_uncertain = FALSE
FROM email_message em
WHERE em.einkauf_id = e.id
  AND e.quelle = 'email'
  AND em.sent_at IS NOT NULL
  AND em.subject !~* '^\s*(wg|fwd?|fw):'
  AND ABS(e.datum - em.sent_at::date) > 21;
