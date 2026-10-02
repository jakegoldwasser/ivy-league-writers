-- Student narrative scratchpad (/student). Students are a separate identity
-- from staff: they never get a row in `users`, and their session cookie is
-- signed for a different purpose, so it can't authenticate any staff route.

CREATE TABLE students (
  email        TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE student_narratives (
  id            TEXT PRIMARY KEY,
  student_email TEXT NOT NULL REFERENCES students(email),
  title         TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL DEFAULT '{}',   -- JSON: { fieldId: text }
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX student_narratives_email ON student_narratives(student_email, updated_at);
