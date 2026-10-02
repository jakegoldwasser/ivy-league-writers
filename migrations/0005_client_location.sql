-- Where a client is based / where sessions happen (free text, e.g. "Upper West Side" or "Zoom").
ALTER TABLE clients ADD COLUMN location TEXT NOT NULL DEFAULT '';
