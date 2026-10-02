-- Scheduling, PAID vs BILLABLE sessions, prepaid packages, and the student directory.
--
-- A session is 'scheduled' (booked ahead by a founder, with calendar invites),
-- 'held' (it happened: logged by the tutor, or a scheduled one the tutor
-- confirmed) or 'cancelled'. Only held sessions count toward tutor pay, and
-- only held BILLABLE ones are ever invoiced. A PAID session draws down the
-- client's prepaid package balance instead.
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('scheduled', 'held', 'cancelled'));
ALTER TABLE sessions ADD COLUMN billing TEXT NOT NULL DEFAULT 'billable' CHECK (billing IN ('billable', 'paid'));
ALTER TABLE sessions ADD COLUMN scheduled_by TEXT;       -- founder who booked it; NULL if the tutor logged it
ALTER TABLE sessions ADD COLUMN cal_uid TEXT;            -- calendar invite UID, stable across updates
ALTER TABLE sessions ADD COLUMN cal_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN invited_at TEXT;         -- last time invites went out
CREATE INDEX sessions_status_date ON sessions(status, date);

ALTER TABLE clients ADD COLUMN student_email TEXT NOT NULL DEFAULT '';
-- What new sessions for this client default to, and the icon on the client list.
ALTER TABLE clients ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'billable' CHECK (billing_mode IN ('billable', 'paid'));
-- A short rundown of the case, for getting someone up to speed.
ALTER TABLE clients ADD COLUMN summary TEXT NOT NULL DEFAULT '';

-- Prepaid packages. Balance = sessions bought - PAID sessions not cancelled.
CREATE TABLE packages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  sessions     INTEGER NOT NULL CHECK (sessions > 0),
  purchased_on TEXT NOT NULL,             -- YYYY-MM-DD
  amount       REAL,                      -- what they paid, optional
  notes        TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX packages_client ON packages(client_id);

ALTER TABLE invoices ADD COLUMN emailed_at TEXT;
ALTER TABLE invoices ADD COLUMN emailed_to TEXT NOT NULL DEFAULT '';
