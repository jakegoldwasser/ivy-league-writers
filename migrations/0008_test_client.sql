-- A TEST client for trying out scheduling, calendar invites and invoices.
-- Every founder stands in as both its parents and its students (the Worker
-- sends its invites and invoice emails to all founders), and its sessions and
-- invoices never count toward real totals: payroll, pay stubs, the 1099 report,
-- the monthly billing email, or invoice numbering (its invoices are TEST-…).

ALTER TABLE clients ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

INSERT INTO clients (name, student, billing_email, student_email, location, default_rate, notes, billing_mode, summary, is_test)
VALUES ('TEST client', 'TEST student', '', '', 'Zoom', 100,
  'For testing. Never counts toward real totals.', 'billable',
  'Not a real family. Every founder is both parent and student here, so invites and invoice emails go to all founders. Use it to try scheduling, invites and invoices.', 1);

-- Every founder can tutor it, so any of them can be booked and confirm sessions.
INSERT OR IGNORE INTO tutor_clients (tutor_email, client_id)
  SELECT u.email, c.id FROM users u, clients c WHERE u.role = 'founder' AND u.active = 1 AND c.is_test = 1;
