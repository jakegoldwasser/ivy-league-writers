# Palisade Writers

Static site (plain HTML/CSS/JS, no framework, no build step) for palisadewriters.com.

- Source of truth for the deployed site is `public/` — edit files there directly.
- Deploys to Cloudflare Workers via Assets (not Pages, not Workers Sites).
- Deploy command: `npm run deploy` (`wrangler deploy`; run `npm install` first)
- Config: `wrangler.jsonc` (routes bind palisadewriters.com + www to this Worker)
- Contact form posts to web3forms.com (access key hardcoded in `public/index.html`).

## Timesheet / invoice portal

- `/timesheet` (tutors log sessions) and `/invoice` (founders: sessions, payroll,
  invoices, team & clients). Pages: `public/timesheet.html`, `public/invoice.html`,
  shared `public/portal.js` + `public/portal.css`.
- `src/worker.js` handles `/api/*` only; everything else falls through to Assets.
  All permission checks live there: tutors see only their own sessions and never
  client rates; `/api/admin/*` is founders only; invoiced sessions are locked.
- Auth: Google Identity Services ID token → verified in the Worker → HMAC-signed
  `pw_session` cookie (secret auto-generated in the D1 `config` table).
  `GOOGLE_CLIENT_ID` and `FOUNDER_EMAILS` are plain vars in `wrangler.jsonc`.
  Everyone else is added in /invoice → Team & clients.
- Data: D1 database `palisade-portal` (binding `DB`). Schema in `migrations/`;
  apply with `npm run db:migrate`. Local test DB: `wrangler d1 migrations apply palisade-portal --local`.
- Local testing: `npm run dev`. `.dev.vars` (gitignored) with `DEV_MODE="1"` enables
  an email-only test login at `/api/dev-login`; it is never on in production.

Legacy: this repo's `main` branch also still deploys to **ivyleaguewriters.com**
via GitHub Pages (the root `CNAME` file), which is a separate, older site under
the "Ivy League Writers" brand. Do not assume AWS is involved anywhere here.
