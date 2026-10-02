-- Pay stubs: the payroll mirror of invoices. Generating one locks the pay
-- rate on the sessions it covers, the same way invoicing locks billing.

CREATE TABLE paystubs (
  id          TEXT PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  tutor_email TEXT NOT NULL REFERENCES users(email),
  period      TEXT NOT NULL,             -- YYYY-MM
  issued_date TEXT NOT NULL,             -- YYYY-MM-DD
  total       REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paid', 'void')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX paystubs_period ON paystubs(period);

CREATE TABLE paystub_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paystub_id  TEXT NOT NULL REFERENCES paystubs(id),
  session_id  INTEGER NOT NULL,
  date        TEXT NOT NULL,
  description TEXT NOT NULL,
  minutes     INTEGER NOT NULL,
  rate        REAL NOT NULL,
  amount      REAL NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX paystub_lines_paystub ON paystub_lines(paystub_id);

ALTER TABLE sessions ADD COLUMN paystub_id TEXT REFERENCES paystubs(id);
