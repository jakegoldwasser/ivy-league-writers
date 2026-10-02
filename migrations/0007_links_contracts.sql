-- Links to a student's working docs (Google Docs etc.), and agreements saved
-- from the Agreement Builder (/contract). A contract is kept exactly as it
-- read when saved (html), plus the form values that produced it (form).

CREATE TABLE client_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL REFERENCES clients(id),
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX client_links_client ON client_links(client_id);

CREATE TABLE contracts (
  id         TEXT PRIMARY KEY,
  client_id  INTEGER NOT NULL REFERENCES clients(id),
  title      TEXT NOT NULL,
  form       TEXT NOT NULL DEFAULT '{}',
  html       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX contracts_client ON contracts(client_id);
