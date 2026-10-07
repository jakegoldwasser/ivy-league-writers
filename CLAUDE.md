# Palisade Writers

Static site (plain HTML/CSS/JS, no framework, no build step) for palisadewriters.com.

- Source of truth for the deployed site is `public/` — edit files there directly.
- Deploys to Cloudflare Workers via Assets (not Pages, not Workers Sites).
- Deploy command: `npm run deploy` (`wrangler deploy`; run `npm install` first)
- **This site is worked on from more than one computer and session, and a deploy
  uploads the local folder wholesale.** So:
  - **Start every task with `git pull --rebase`** on `palisade-rebrand`, before reading
    or editing anything. Working from a stale checkout is how changes get lost.
  - **Commit and push before deploying.** `npm run predeploy` (run automatically by
    `npm run deploy`) refuses to deploy when the checkout is dirty, behind or ahead of
    GitHub, or when production has a D1 migration this checkout lacks. Never bypass it
    (e.g. with a bare `npx wrangler deploy`); fix the cause instead.
  - New migrations take the next number after the highest one on GitHub *and* in
    production (`SELECT name FROM d1_migrations`). `0006_invoice_overrides.sql`
    shares 0006 with `0006_scheduling.sql` for historical reasons; don't rename it.
- Config: `wrangler.jsonc` (routes bind palisadewriters.com + www to this Worker)
- Contact form posts to web3forms.com (access key hardcoded in `public/index.html`).
- Landing copy must not promise admissions (or publication) outcomes — no "we get
  students into…" or "deliver results". Past student admits ("Admitted to Penn ·
  Columbia…" hero stat) are fine and wanted. The footer carries a no-guarantee disclaimer.

## Timesheet / invoice portal

- `/timesheet` (tutors log sessions) and `/invoice` (founders: sessions, payroll,
  invoices, team & clients). Pages: `public/timesheet.html`, `public/invoice.html`,
  shared `public/portal.js` + `public/portal.css`.
- `src/worker.js` handles `/api/*` only; everything else falls through to Assets.
  All permission checks live there: tutors see only their own sessions and never
  client rates; `/api/admin/*` is founders only; invoiced sessions are billing-locked
  (pay stays editable); a tutor (not a founder) can't edit/delete a session more than
  31 days old (`daysAgo()` in `src/worker.js`) — that's the only pay data-integrity
  control, see Pay stubs below.
- Auth: Google Identity Services ID token → verified in the Worker → HMAC-signed
  `pw_session` cookie (secret auto-generated in the D1 `config` table).
  `GOOGLE_CLIENT_ID` and `FOUNDER_EMAILS` are plain vars in `wrangler.jsonc`.
  Everyone else is added in /invoice → Team & clients.
- Data: D1 database `palisade-portal` (binding `DB`). Schema in `migrations/`;
  apply with `npm run db:migrate`. Local test DB: `wrangler d1 migrations apply palisade-portal --local`.
- Local testing: `npm run dev`. `.dev.vars` (gitignored) with `DEV_MODE="1"` enables
  an email-only test login at `/api/dev-login`; it is never on in production.
- Deleting a client or a person (Team & clients) also deletes their uninvoiced
  sessions and assignments; anyone with an invoiced session can only be made
  inactive. You can't delete yourself or a `FOUNDER_EMAILS` founder.
- Every client must have a `default_rate` (enforced server-side and via `required`
  on the form) — there is no such thing as a client without a billing rate.

### TEST client

- There is one **TEST client** ("TEST client" / "TEST student", `clients.is_test = 1`,
  migration `0008_test_client.sql`) for trying out scheduling, calendar invites and
  invoices end to end. **Every founder is both its parent and its student**: its
  calendar invites and invoice emails go to all founders (`founderEmails()`), never to
  anyone else, and every founder is assigned as its tutor.
- **It must never add to any real totals or accounting docs.** Its sessions are left
  out of the monthly payroll summary (`computeMonthlyPayroll`), the 1099-NEC tax report
  (`/api/admin/tax`), pay stubs, the Sessions & payroll stats and the CSV export (the
  page only counts them when the Client filter is set to the TEST client). Its invoices
  are numbered in their own `TEST-YYYYMM-NN` series, so they never use up a real
  `PW-` number, and the monthly billing email lists them apart, under "TEST invoices
  (not real, not counted)". Every new total, report or export must leave it out too.
  It's marked with a TEST pill everywhere it shows.
- The weekly update (`ops/weekly-update.md`) leaves it alone.

### Editing the invoice in place

- The live preview in the invoice builder is the editor: every piece of text on it is
  `contenteditable` (`invoiceDoc(inv, true)` in `invoice.html`). Line fields write back to
  the builder's `draft`; everything else goes into `ov`, keyed by `data-ov`.
- On save, `bill_to`/`student`/`from_line`/`number` go to their own columns, a typed total
  replaces the sum, a typed line amount replaces hours × rate, and all other text (labels,
  payment methods, fee paragraph, footer) is stored as JSON in `invoices.overrides`
  (migration `0006_invoice_overrides.sql`). The print view and the client email
  (`invoiceEmailHtml`) both read it. A typed invoice number must be unused and doesn't
  advance the `nextNumber()` series.

### Voiding vs deleting invoices

- **Void** keeps the invoice on record, marked void, and frees its sessions to be
  billed again. **Delete** removes the invoice and its lines outright (any status) and
  also frees its sessions. Either way **an invoice number is never reused**:
  `nextNumber()` takes the highest number ever issued for that month, from the
  invoices still saved and the high-water mark it records in `config`
  (`last_invoice_number:<prefix>`). Once a client's invoices are all deleted, the
  client itself can be deleted.

### Pay stubs & bulk generation

- Pay stubs are **stateless** — there is no `paystubs` table (migration
  `0002_paystubs.sql` added one; `0003_drop_paystubs.sql` removed it — locking pay
  to a saved record was tried and explicitly rejected). "Generate Paystubs" on
  `/invoice` (Sessions & payroll tab) just reads the currently-filtered `rows` in
  the browser and prints one doc per tutor (`paystubDoc()` in `invoice.html`) from
  whatever's logged right now — nothing is saved, nothing is locked. Re-running it
  later can show different numbers if sessions changed since; that's intentional.
- "Generate All Invoices" (Invoices tab, pick "All clients" in the Client dropdown)
  is unrelated and still persists: one invoice per active client with uninvoiced
  sessions that month, using each client's configured rate, skipping (with a
  reported reason) any client missing one — `generateAllInvoices` in `src/worker.js`.
  Invoicing still locks billing on the sessions it covers (`sessions.invoice_id`).
- A Cloudflare Cron Trigger (`triggers.crons` in `wrangler.jsonc`, 13:00 UTC on the
  1st) runs `scheduled()` in `src/worker.js`: generates last month's invoices the
  same way, computes a read-only payroll-by-tutor summary (`computeMonthlyPayroll`,
  no locking), and emails both to `FOUNDER_EMAILS` via Resend (`RESEND_API_KEY` —
  a secret, set with `npx wrangler secret put RESEND_API_KEY`; `EMAIL_FROM` is a
  plain var and must be on a domain verified in Resend). The email doesn't attach
  pay stub PDFs — those are only ever generated on demand from live data in the UI.
- Cron triggers need a `workers.dev` subdomain on the account (one-time: open the
  Workers & Pages dashboard once) — `npm run deploy` otherwise deploys the Worker
  fine but errors on the trigger step.

## Student narrative scratchpad

- `/student` (`public/student.html`, self-contained, doesn't use `portal.js`/`portal.css`):
  any Google account can sign in and sketch a college-essay narrative arc in seven
  prompt sections; autosaves to D1 (`students`, `student_narratives`, migration 0004).
- **Students must never reach staff tools.** They're a separate identity: routes are
  `/api/student/*` only (`studentRoutes` in `src/worker.js`, dispatched before the staff
  session is read), cookie is `pw_student` scoped to `Path=/api/student`, and its HMAC
  signs `'student:' + payload` so it can't be replayed as `pw_session` even for a
  founder's email. Student sign-in never creates a `users` row. Every narrative query
  is keyed on `(id, student_email)`.
- "Save as Google Doc" is client-side only: a GIS token client with the `drive.file`
  scope uploads HTML to Drive as a native Doc. Requires the Google Drive API to be
  enabled on the OAuth client's Cloud project and `drive.file` on the consent screen.
  If it fails, the page falls back to copy-to-clipboard + docs.new.

Legacy: this repo's `main` branch also still deploys to **ivyleaguewriters.com**
via GitHub Pages (the root `CNAME` file), which is a separate, older site under
the "Ivy League Writers" brand. Do not assume AWS is involved anywhere here.

## Scheduling, PAID/BILLABLE, invites (migration 0006)

- A session's `status` is `scheduled` (booked ahead by a founder in the Schedule
  tab), `held` (it happened) or `cancelled`; its `billing` is `billable` (gets
  invoiced) or `paid` (drawn from the client's prepaid `packages`). Only held
  sessions count toward pay and 1099 totals; only held BILLABLE ones are invoiced.
- Past scheduled sessions wait for the tutor to confirm them on /timesheet ("Did
  these happen?"). Logging a session on a booked day confirms that booking.
  Tutors can't move or delete a founder's booking.
- Calendar invites are .ics emails sent through Resend from `CALENDAR_ORGANIZER`
  (default jake@palisadewriters.com, which must be on the Resend-verified domain)
  to the parent (billing email), the student (if `student_email` is set; missing
  it never blocks booking) and the tutor. Moves re-send with a higher SEQUENCE;
  cancellations send METHOD:CANCEL.
- Billing email (invoice "Email to client", the monthly summary) goes to the
  client and every active founder, never a tutor (`founderEmails`).
- Students tab: a directory with each client's rundown (`clients.summary`),
  student email, active flag and package balance.


## Weekly dashboard (`/dashboard`, migration 0009)

- `public/dashboard.html` (uses `portal.js`/`portal.css`), founders only, via
  `/api/admin/dashboard?week=YYYY-MM-DD` and `/api/admin/docket[/:id]`. One week,
  Monday to Sunday: **Student meetings** (sessions booked in the portal, merged
  with the crawl's meeting items for the same student and day, with prep notes),
  **Docs to answer**, **Payments to collect** (unpaid draft/sent portal invoices,
  read live, plus money owed outside the portal), **Emails to answer**, **Other
  to-dos**. A filter shows Everyone or one founder; an item's owner is a founder's
  email or `''` for both.
- Everything that isn't live portal data lives in the `docket` table. Most of it is
  written by the **dashboard crawl** (`ops/dashboard-crawl.md`), a local scheduled
  Claude Code task that reads a founder's Gmail (texts and WhatsApp later) and
  upserts by `source_ref`, never touching an item's `status` or `owner`, so what a
  founder ticks off or reassigns stays that way. It never changes invoices; a payment
  that arrives for one becomes a to-do to mark it paid. `config` row
  `docket_crawled:<email>` is when that inbox was last read (shown on the page).
- The TEST client is left out of the dashboard.
