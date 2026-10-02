-- Timesheet + invoicing portal (/timesheet, /invoice)

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  email            TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL CHECK (role IN ('founder', 'tutor')),
  default_pay_rate REAL,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  student       TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  default_rate  REAL,
  notes         TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which tutors work with which clients, plus optional per-pair rates.
-- pay_rate overrides the tutor's default pay; client_rate overrides the
-- client's default billing rate for sessions with this tutor.
CREATE TABLE tutor_clients (
  tutor_email TEXT NOT NULL REFERENCES users(email),
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  pay_rate    REAL,
  client_rate REAL,
  PRIMARY KEY (tutor_email, client_id)
);

CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  period      TEXT NOT NULL,             -- YYYY-MM
  issued_date TEXT NOT NULL,             -- YYYY-MM-DD
  due_text    TEXT NOT NULL DEFAULT '',
  bill_to     TEXT NOT NULL,             -- snapshots, so later edits don't rewrite old invoices
  student     TEXT NOT NULL DEFAULT '',
  from_line   TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  total       REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX invoices_period ON invoices(period);

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tutor_email TEXT NOT NULL REFERENCES users(email),
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  start_time  TEXT NOT NULL DEFAULT '',  -- HH:MM, optional
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  service     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  pay_rate    REAL,                      -- what the tutor earns per hour for this session
  client_rate REAL,                      -- set when the session is invoiced
  invoice_id  TEXT REFERENCES invoices(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX sessions_date ON sessions(date);
CREATE INDEX sessions_tutor_date ON sessions(tutor_email, date);
CREATE INDEX sessions_client_date ON sessions(client_id, date);

CREATE TABLE invoice_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id),
  session_id  INTEGER,
  date        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  minutes     INTEGER,
  rate        REAL,
  amount      REAL NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoice_lines_invoice ON invoice_lines(invoice_id);
