# Weekly Palisade update

Instructions for a Claude Code scheduled task that runs on Jake's **main
(personal) computer**, not his work computer. Set it up there by opening
Claude Code in `~/code/palisade-writers` and saying:

> Set up the weekly Palisade update from ops/weekly-update.md

That setup should: `git pull`; make sure Node.js is available (official LTS
tarball from nodejs.org, checksum-verified, in `~/.local/node`, with Jake's
OK); `npm install`; confirm `npx wrangler whoami` shows jake.goldwasser@gmail.com
(if not, run `npx wrangler login` and let Jake sign in); make sure the Gmail,
Google Drive and Google Calendar connectors are connected; add allow rules
for the read-only Gmail tools (`search_threads`, `get_thread`) so auto mode
doesn't block them; then create a local scheduled task, **Mondays at 7:00 am**,
whose prompt is everything under "The task" below.

---

## The task

You are updating the Palisade Writers tutoring portal (palisadewriters.com,
repo `~/code/palisade-writers`, Cloudflare D1 database `palisade-portal`) from
Jake Goldwasser's Google Calendar, Gmail and Google Drive. Jake chose **apply,
then report**: make the changes below directly, then give him a short summary
of every change and of anything you weren't sure about (which you leave alone).

Ground rules:
- Never send email, create or send invoices, create calendar events, or change
  rates. Read Gmail/Calendar/Drive only.
- Before writing anything, back up the database:
  `npx wrangler d1 export palisade-portal --remote --output backups/palisade-portal-<date>-weekly.sql`
  (`backups/` is gitignored; it holds client data).
- Run SQL with `CI=1 npx wrangler d1 execute palisade-portal --remote --json --command "..."`
  from `~/code/palisade-writers`, with `~/.local/node/bin` on PATH. Escape single
  quotes in text by doubling them.
- When unsure, don't change it: list it in the report.

### 1. Read the portal
`SELECT * FROM clients;`, `SELECT email, name, role FROM users;`,
`SELECT * FROM packages;`, and the last 60 days of
`SELECT * FROM sessions WHERE date >= date('now','-60 days');`.
Clients are parents/families; `student` is the student's name.
`billing_mode` is `paid` (prepaid package) or `billable`.

### 2. Sessions that happened (Google Calendar is accurate)
Look at Jake's calendar from the day after the previous run (or 8 days ago)
through yesterday. Tutoring events are titled like "Kingsley / Jake",
"Jake / Isaac", "Agastya / Jake Kickoff", or have the student or parent as an
attendee. Match each event to a client by student name or attendee email
(student_email, billing_email). Skip events Jake declined, cancelled events,
and events whose only attendee declined.

For each matched event that already ended:
- If a session exists for that client on that date (any status), don't add
  another. If it's `scheduled` and its tutor is Jake, mark it held:
  `UPDATE sessions SET status='held', updated_at=datetime('now') WHERE id=?`.
  Leave other tutors' scheduled sessions for them to confirm.
- Otherwise insert it as held:
  `INSERT INTO sessions (tutor_email, client_id, date, start_time, minutes, service, notes, pay_rate, status, billing)
   VALUES ('jake.goldwasser@gmail.com', <client_id>, '<YYYY-MM-DD>', '<HH:MM>', <event minutes>, 'Tutoring session',
   'Logged from Google Calendar (weekly update)', NULL, 'held', '<client billing_mode>');`
  Dates and times are New York time.
PAID sessions draw down the client's package automatically. If a PAID client's
balance goes below zero, say so in the report.

### 3. Gmail and Drive, last 8 days
For each client, search Gmail (student and parent names and emails, doc
comment notifications, payment alerts from Zelle/PayPal/Venmo) and Drive
(files shared by the student). From that:
- **Student email**: if `student_email` is blank and you find the student's own
  address (they sent mail, accepted an invite, or own a shared doc), set it.
- **Packages**: if a family paid for a package and the number of sessions is
  clear from the email, add it:
  `INSERT INTO packages (client_id, sessions, purchased_on, amount, notes, created_by) VALUES (...,'weekly-update')`.
  If the count isn't clear, report it instead.
- **Docs**: for each Google Doc/Sheet/Slides file the student shared with Jake
  (or Jake shared with them) that isn't already linked, add it:
  `INSERT INTO client_links (client_id, title, url, added_by) VALUES (<id>, '<file title>', '<view url>', 'weekly-update');`
  (check `SELECT url FROM client_links WHERE client_id = <id>` first).
- **Rundown** (`clients.summary`, 100-200 words, up to ~300 for complex cases):
  keep it a current picture of the case (who, goals, deadlines, where the work
  lives, what's next, anything to watch), not a diary. Fold in what changed
  this week; don't just append. Keep facts Jake entered.
- **Active**: set `active=1` for any client with a session or real contact
  this week. Set `active=0` only when there has been no session and no contact
  for 60 days; list those in the report.
- Note unanswered questions from parents older than 2 days in the report.

### 4. Report
End with a summary for Jake: sessions logged (per student, with dates),
sessions marked held, package balances that changed or went negative, emails
and packages added, rundowns updated, active flags changed, unanswered
parent emails, and anything you skipped because you weren't sure.
