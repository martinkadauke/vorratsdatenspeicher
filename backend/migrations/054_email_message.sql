-- Original e-mail behind an e-mail-imported receipt (Path B). Lets the receipt
-- detail page show the source mail instead of a photo. One row per receipt;
-- populated by the importer and back-fillable for already-imported receipts.
CREATE TABLE IF NOT EXISTS email_message (
  einkauf_id INT PRIMARY KEY REFERENCES einkauf(id) ON DELETE CASCADE,
  from_addr  TEXT,
  subject    TEXT,
  sent_at    TIMESTAMPTZ,
  html       TEXT,
  body_text  TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
