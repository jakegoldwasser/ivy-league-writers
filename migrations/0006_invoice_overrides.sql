-- Shares the 0006 prefix with 0006_scheduling.sql: it was first applied to production under this name, so it keeps it.
-- Free-text edits made directly on the invoice document (labels, payment text, fee text, etc.), as a JSON object of key -> string.
ALTER TABLE invoices ADD COLUMN overrides TEXT NOT NULL DEFAULT '{}';
