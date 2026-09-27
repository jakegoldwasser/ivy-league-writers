# Palisade Writers

Static site (plain HTML/CSS/JS, no framework, no build step) for palisadewriters.com.

- Source of truth for the deployed site is `public/` — edit files there directly.
- Deploys to Cloudflare Workers via Assets (not Pages, not Workers Sites).
- Deploy command: `npm run deploy` (`wrangler deploy`; run `npm install` first)
- Config: `wrangler.jsonc` (routes bind palisadewriters.com + www to this Worker)
- Contact form posts to web3forms.com (access key hardcoded in `public/index.html`).
- Landing copy must not promise or imply admissions (or publication) outcomes: no
  "admitted to…" lists or "deliver results". The footer carries a no-guarantee disclaimer.

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
