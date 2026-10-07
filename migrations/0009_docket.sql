-- The founders' weekly dashboard (/dashboard): what's on the docket this week.
-- Live portal data (scheduled sessions, unpaid invoices) is read straight from
-- the other tables; this table holds everything else, mostly written by the
-- dashboard crawl (ops/dashboard-crawl.md), which reads Gmail (and later texts
-- and WhatsApp) on a founder's computer.
--
-- kind:   meeting (a student meeting to prep for), doc (a Google Doc someone
--         tagged or commented on, waiting for a reply), payment (money owed to
--         us), reply (an email waiting on an answer), task (anything else)
-- owner:  a founder's email, or '' for both founders
-- source: gmail, calendar, drive, imessage, whatsapp or manual
-- source_ref: the crawl's stable key for the thing it found (e.g.
--         gmail:<thread id>:doc), so re-running the crawl updates an item
--         instead of adding it twice and never reopens one marked done.
CREATE TABLE docket (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('meeting', 'doc', 'payment', 'reply', 'task')),
  owner      TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',  -- context, or prep notes for a meeting
  url        TEXT NOT NULL DEFAULT '',  -- the doc, thread or event
  due        TEXT NOT NULL DEFAULT '',  -- YYYY-MM-DD or 'YYYY-MM-DD HH:MM' (New York time); '' = no date
  client_id  INTEGER REFERENCES clients(id),
  amount     REAL,
  source     TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT UNIQUE,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  done_by    TEXT,
  done_at    TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX docket_status_due ON docket(status, due);
