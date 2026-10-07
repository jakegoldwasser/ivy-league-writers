// Palisade Writers Worker.
// Static pages in public/ are served by Workers Assets; this script only
// handles /api/*, which backs the /timesheet (tutor) and /invoice (founder)
// portals. Auth is Google Sign-In -> verified here -> signed session cookie.
// Every permission check happens here, never in the browser.

const COOKIE = 'pw_session';
const SESSION_DAYS = 14;
const SERVICES = ['Tutoring session', 'Essay / async feedback', 'Consultation', 'Prep', 'Other'];
// Session dates and times are wall-clock times here.
const TZ = 'America/New_York';
// Calendar invites come from this address (set CALENDAR_ORGANIZER to change it).
const DEFAULT_ORGANIZER = 'jake@palisadewriters.com';
const MAX_SCHEDULE = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },

  // Cron trigger (wrangler.jsonc) fires on the 1st of each month: generates
  // invoices and pay stubs for the month that just ended, and emails a summary.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonthlyBilling(env));
  },
};

async function runMonthlyBilling(env) {
  const founders = await founderEmails(env);
  if (!founders.length) { console.error('No founders configured; skipping monthly billing run.'); return; }
  const systemUser = { email: founders[0] };
  const period = previousMonth(new Date());
  const issued_date = new Date().toISOString().slice(0, 10);

  const invoices = await generateAllInvoices(env, systemUser, period, { issued_date, due_text: 'Within 7 days of this invoice', llc: false });
  const payroll = await computeMonthlyPayroll(env, period);
  const unconfirmed = await unconfirmedSessions(env);

  if (!env.RESEND_API_KEY) { console.error('No RESEND_API_KEY configured; skipping monthly billing email.'); return; }
  await sendMonthlyEmail(env, founders, period, invoices, payroll, unconfirmed);
}

// Every active founder in the portal (so Abby as well as Jake), plus the
// FOUNDER_EMAILS in the config. Billing email goes to these people and
// never to a tutor.
async function founderEmails(env) {
  const { results } = await env.DB.prepare("SELECT email FROM users WHERE role = 'founder' AND active = 1").all();
  const fromConfig = (env.FOUNDER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...fromConfig, ...results.map(r => r.email)])];
}

// Scheduled sessions whose day has passed but the tutor hasn't confirmed.
async function unconfirmedSessions(env) {
  const { results } = await env.DB.prepare(`SELECT s.id, s.date, s.start_time, u.name AS tutor_name, s.tutor_email,
      c.name AS client_name, c.student, c.is_test FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id
      WHERE s.status = 'scheduled' AND s.date < ? ORDER BY s.date`).bind(todayLocal()).all();
  return results;
}

// Sends one email through Resend. Never throws: returns { ok, error }.
async function sendEmail(env, msg) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email isn’t set up (no RESEND_API_KEY).' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify(msg),
    });
    if (res.ok) return { ok: true };
    const text = await res.text();
    console.error('Resend email failed:', res.status, text);
    // Resend allows a few requests a second; one retry after a pause covers a burst.
    if (res.status === 429 && !msg._retried) { await sleep(1200); return sendEmail(env, { ...msg, _retried: true }); }
    return { ok: false, error: `Email failed (${res.status}).` };
  } catch (err) {
    console.error('Resend email error:', err);
    return { ok: false, error: 'Could not reach the email service.' };
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function previousMonth(d) {
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return prev.toISOString().slice(0, 7);
}

async function sendMonthlyEmail(env, founders, period, invoices, payroll, unconfirmed) {
  const real = invoices.created.filter(i => !i.test), tests = invoices.created.filter(i => i.test);
  const table = (items, label) => items.length
    ? `<table cellpadding="4" cellspacing="0"><tr><th align="left">${label}</th><th align="right">Total</th></tr>${
        items.map(i => `<tr><td>${esc(i.name)} (${esc(i.number)})</td><td align="right">$${i.total.toFixed(2)}</td></tr>`).join('')
      }</table>` : '<p>None.</p>';
  const skippedList = items => items.length
    ? `<p><strong>Skipped — needs a rate:</strong></p><ul>${items.map(i => `<li>${esc(i.name)} — ${esc(i.reason)}</li>`).join('')}</ul>` : '';
  const payrollTable = payroll.length
    ? `<table cellpadding="4" cellspacing="0"><tr><th align="left">Tutor</th><th align="right">Pay owed</th></tr>${
        payroll.map(t => `<tr><td>${esc(t.name)}${t.missing ? ' (' + t.missing + ' session(s) missing a pay rate)' : ''}</td><td align="right">$${t.pay.toFixed(2)}</td></tr>`).join('')
      }</table>` : '<p>None.</p>';

  const html = `
    <h2>Palisade Writers — ${esc(period)} billing</h2>
    <p>Generated automatically on the 1st. Sign in at
      <a href="https://palisadewriters.com/invoice">palisadewriters.com/invoice</a> to review, print, and send invoices,
      and to generate pay stubs from the Payroll tab.</p>
    <h3>Invoices to send (${real.length})</h3>
    ${table(real, 'Client')}
    ${skippedList(invoices.skipped)}
    ${tests.length ? `<h3>TEST invoices (not real, not counted)</h3>${table(tests, 'Client')}` : ''}
    <h3>Payroll owed</h3>
    ${payrollTable}
    ${unconfirmed.length ? `<h3>Waiting for the tutor to confirm (${unconfirmed.length})</h3>
    <p>Scheduled sessions whose day has passed. They aren't paid or invoiced until they're confirmed.</p>
    <ul>${unconfirmed.map(u => `<li>${u.is_test ? 'TEST · ' : ''}${esc(u.date)} ${esc(u.start_time)} — ${esc(u.client_name)}${u.student ? ' (' + esc(u.student) + ')' : ''} with ${esc(u.tutor_name || u.tutor_email)}</li>`).join('')}</ul>` : ''}
  `;

  await sendEmail(env, {
    from: env.EMAIL_FROM || 'Palisade Writers <billing@palisadewriters.com>',
    to: founders,
    subject: `Palisade Writers — ${period} invoices & payroll summary`,
    html,
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => { throw new HttpError(400, msg); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// ---------- routing ----------

async function handleApi(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  if (method !== 'GET') {
    // Block cross-site writes: browsers always send Origin on these.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Bad origin.');
  }

  if (path === '/api/config' && method === 'GET') {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', services: SERVICES, devLogin: env.DEV_MODE === '1',
      calendarOrganizer: env.CALENDAR_ORGANIZER || DEFAULT_ORGANIZER });
  }
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  // Local testing only: DEV_MODE lives in .dev.vars, which is never deployed.
  if (path === '/api/dev-login' && env.DEV_MODE === '1' && method === 'POST') {
    const { email } = await body(request);
    const user = await loadUser(env, String(email || '').toLowerCase());
    if (!user) throw new HttpError(403, 'Not on the list.');
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env, user.email) });
  }

  // Students (/student) are handled entirely separately and return before the
  // staff session is ever consulted. See studentRoutes().
  if (path === '/api/student' || path.startsWith('/api/student/')) {
    return studentRoutes(request, env, path.slice(12).split('/').filter(Boolean), url);
  }

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please sign in.');

  if (path === '/api/me' && method === 'GET') {
    return json({ email: user.email, name: user.name, role: user.role });
  }
  if (path.startsWith('/api/my/')) return myRoutes(request, env, user, path.slice(8).split('/'), url);
  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'founder') throw new HttpError(403, 'Founders only.');
    return adminRoutes(request, env, user, path.slice(11).split('/'), url);
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- auth ----------

async function login(request, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured yet.');
  const { credential } = await body(request);
  if (typeof credential !== 'string') bad('Missing Google credential.');
  const claims = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID);
  const email = claims.email.toLowerCase();
  const user = await loadUser(env, email);
  if (!user) {
    throw new HttpError(403, `${email} doesn't have access. Ask a Palisade Writers founder to add you.`);
  }
  if (!user.name && claims.name) {
    await env.DB.prepare('UPDATE users SET name = ? WHERE email = ?').bind(claims.name, email).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env, email) });
}

let googleKeyCache = { keys: null, until: 0 };
async function googleKeys() {
  if (googleKeyCache.keys && Date.now() < googleKeyCache.until) return googleKeyCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new HttpError(502, 'Could not reach Google to verify sign-in.');
  const { keys } = await res.json();
  googleKeyCache = { keys, until: Date.now() + 60 * 60 * 1000 };
  return keys;
}

async function verifyGoogleToken(token, clientId) {
  const fail = () => { throw new HttpError(401, 'Google sign-in could not be verified. Please try again.'); };
  const parts = token.split('.');
  if (parts.length !== 3) fail();
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch { fail(); }
  if (header.alg !== 'RS256') fail();
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) fail();
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  const now = Date.now() / 1000;
  if (!ok) fail();
  if (claims.aud !== clientId) fail();
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') fail();
  if (!(claims.exp > now)) fail();
  if (!claims.email || claims.email_verified !== true) fail();
  return claims;
}

async function hmacKey(env) {
  const read = () => env.DB.prepare("SELECT value FROM config WHERE key = 'session_secret'").first();
  let row = await read();
  if (!row) {
    const secret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('session_secret', ?)").bind(secret).run();
    row = await read();
  }
  return crypto.subtle.importKey('raw', new TextEncoder().encode(row.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// `purpose` is mixed into what gets signed, so a student cookie's signature is
// never valid as a staff cookie (or vice versa) even if someone renames it.
async function signedValue(env, email, purpose) {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(purpose + payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function readSigned(request, env, name, purpose) {
  const cookies = Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const raw = cookies[name];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlDecode(sig), new TextEncoder().encode(purpose + payload));
  } catch { return null; }
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  return data.x > Date.now() ? data.e : null;
}

async function sessionCookie(env, email) {
  return `${COOKIE}=${await signedValue(env, email, '')}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function currentUser(request, env) {
  const email = await readSigned(request, env, COOKIE, '');
  // Re-checked on every request, so deactivating someone takes effect immediately.
  return email ? loadUser(env, email) : null;
}

// Founders listed in FOUNDER_EMAILS get an account automatically the first time.
async function loadUser(env, email) {
  if (!email) return null;
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (row) return row.active ? row : null;
  const founders = (env.FOUNDER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!founders.includes(email)) return null;
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, role) VALUES (?, 'founder')").bind(email).run();
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

// ---------- student routes (/api/student/*) ----------
// Any verified Google account can sign in as a student. Students get their own
// cookie (pw_student, scoped to /api/student, signed with a different purpose
// than pw_session) and their own table, so a student session can only ever
// reach the routes below — never /api/me, /api/my/* or /api/admin/*. Signing in
// here also never creates or touches a staff `users` row.

const STUDENT_COOKIE = 'pw_student';
const STUDENT_PURPOSE = 'student:';
const MAX_NARRATIVES = 30;
const MAX_NARRATIVE_BYTES = 100_000;

async function studentCookie(env, email) {
  return `${STUDENT_COOKIE}=${await signedValue(env, email, STUDENT_PURPOSE)}; Path=/api/student; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function upsertStudent(env, email, name) {
  await env.DB.prepare(`INSERT INTO students (email, name) VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET last_seen_at = datetime('now'), name = CASE WHEN students.name = '' THEN excluded.name ELSE students.name END`)
    .bind(email, name || '').run();
}

async function studentRoutes(request, env, seg, url) {
  const method = request.method;

  if (seg[0] === 'login' && method === 'POST') {
    if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured yet.');
    const { credential } = await body(request);
    if (typeof credential !== 'string') bad('Missing Google credential.');
    const claims = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID);
    const email = claims.email.toLowerCase();
    await upsertStudent(env, email, String(claims.name || '').slice(0, 120));
    return json({ ok: true }, 200, { 'Set-Cookie': await studentCookie(env, email) });
  }
  if (seg[0] === 'dev-login' && env.DEV_MODE === '1' && method === 'POST') {
    const email = String((await body(request)).email || '').trim().toLowerCase();
    if (!email.includes('@')) bad('Enter an email.');
    await upsertStudent(env, email, '');
    return json({ ok: true }, 200, { 'Set-Cookie': await studentCookie(env, email) });
  }
  if (seg[0] === 'logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${STUDENT_COOKIE}=; Path=/api/student; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  const email = await readSigned(request, env, STUDENT_COOKIE, STUDENT_PURPOSE);
  const student = email && await env.DB.prepare('SELECT email, name FROM students WHERE email = ?').bind(email).first();
  if (!student) throw new HttpError(401, 'Please sign in.');

  if (seg[0] === 'me' && seg.length === 1 && method === 'GET') return json(student);

  if (seg[0] !== 'narratives') throw new HttpError(404, 'Not found.');

  if (seg.length === 1 && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, title, updated_at FROM student_narratives WHERE student_email = ? ORDER BY updated_at DESC',
    ).bind(email).all();
    return json(results);
  }
  if (seg.length === 1 && method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM student_narratives WHERE student_email = ?').bind(email).first();
    if (count.n >= MAX_NARRATIVES) bad(`You can keep up to ${MAX_NARRATIVES} narratives. Delete one to start another.`);
    const b = await body(request);
    const id = crypto.randomUUID();
    const data = narrativeData(b.data);
    await env.DB.prepare('INSERT INTO student_narratives (id, student_email, title, data) VALUES (?, ?, ?, ?)')
      .bind(id, email, str(b.title, 200, 'Title'), data).run();
    return json({ id });
  }
  if (seg.length === 2) {
    // Every lookup is keyed on (id, student_email), so one student can never read or change another's.
    const id = seg[1];
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT id, title, data, updated_at FROM student_narratives WHERE id = ? AND student_email = ?')
        .bind(id, email).first();
      if (!row) throw new HttpError(404, 'That narrative was not found.');
      return json({ ...row, data: JSON.parse(row.data) });
    }
    if (method === 'PUT') {
      const b = await body(request);
      const r = await env.DB.prepare(`UPDATE student_narratives SET title = ?, data = ?, updated_at = datetime('now')
        WHERE id = ? AND student_email = ?`).bind(str(b.title, 200, 'Title'), narrativeData(b.data), id, email).run();
      if (!r.meta.changes) throw new HttpError(404, 'That narrative was not found.');
      return json({ ok: true, updated_at: new Date().toISOString() });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM student_narratives WHERE id = ? AND student_email = ?').bind(id, email).run();
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

// Only a flat map of short field ids to strings is stored, so the blob stays inert.
function narrativeData(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('Invalid narrative.');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(k) || typeof val !== 'string') bad('Invalid narrative.');
    out[k] = val;
  }
  const s = JSON.stringify(out);
  if (s.length > MAX_NARRATIVE_BYTES) bad('This narrative is too long to save. Try trimming a few fields.');
  return s;
}

// ---------- tutor routes (/api/my/*): only ever touch the signed-in user's own sessions ----------

async function myRoutes(request, env, user, seg, url) {
  const method = request.method;

  if (seg[0] === 'clients' && seg.length === 1 && method === 'GET') {
    const { results } = user.role === 'founder'
      ? await env.DB.prepare('SELECT id, name, student, student_email FROM clients WHERE active = 1 ORDER BY name').all()
      : await env.DB.prepare(`SELECT c.id, c.name, c.student, c.student_email FROM tutor_clients tc JOIN clients c ON c.id = tc.client_id
          WHERE tc.tutor_email = ? AND c.active = 1 ORDER BY c.name`).bind(user.email).all();
    return json(results);
  }

  // PUT /api/my/clients/:id { student_email } -- tutors help collect student
  // emails (for calendar invites). Only fills in a blank one; changing an
  // existing address is a founder's job.
  if (seg[0] === 'clients' && seg.length === 2 && method === 'PUT') {
    const clientId = intParam(seg[1]);
    await assertCanUseClient(env, user, clientId);
    const email = emailParam((await body(request)).student_email, 'Student email');
    if (!email) bad('Enter the student’s email.');
    const r = await env.DB.prepare("UPDATE clients SET student_email = ? WHERE id = ? AND student_email = ''").bind(email, clientId).run();
    if (!r.meta.changes) throw new HttpError(409, 'This student already has an email on file. Ask a founder to change it.');
    return json({ ok: true });
  }

  if (seg[0] !== 'sessions') throw new HttpError(404, 'Not found.');

  if (seg.length === 1 && method === 'GET') {
    const month = monthParam(url.searchParams.get('month'));
    // Deliberately no client billing rates here.
    const { results } = await env.DB.prepare(`SELECT s.id, s.client_id, c.name AS client_name, c.student, s.date, s.start_time,
        s.minutes, s.service, s.notes, s.pay_rate, s.status, (s.scheduled_by IS NOT NULL) AS was_scheduled,
        (s.invoice_id IS NOT NULL) AS locked
        FROM sessions s JOIN clients c ON c.id = s.client_id
        WHERE s.tutor_email = ? AND substr(s.date, 1, 7) = ? ORDER BY s.date, s.start_time, s.id`)
      .bind(user.email, month).all();
    return json(results);
  }

  // Scheduled sessions past their day, any month -- the "please confirm" list.
  if (seg[1] === 'unconfirmed' && seg.length === 2 && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT s.id, s.client_id, c.name AS client_name, c.student, s.date, s.start_time,
        s.minutes, s.service FROM sessions s JOIN clients c ON c.id = s.client_id
        WHERE s.tutor_email = ? AND s.status = 'scheduled' AND s.date <= ? ORDER BY s.date, s.start_time`)
      .bind(user.email, todayLocal()).all();
    return json(results);
  }

  if (seg.length === 1 && method === 'POST') {
    const s = sessionFields(await body(request));
    await assertCanUseClient(env, user, s.client_id);
    // Logging a session that was already booked for that day confirms the
    // booking instead of adding a second copy of it.
    const booked = await env.DB.prepare(`SELECT id FROM sessions WHERE tutor_email = ? AND client_id = ? AND date = ?
        AND status = 'scheduled' ORDER BY start_time LIMIT 1`).bind(user.email, s.client_id, s.date).first();
    if (booked) {
      if (s.date > todayLocal()) bad('That session is scheduled for later. Log it on or after the day it happens.');
      await env.DB.prepare(`UPDATE sessions SET status = 'held', start_time = ?, minutes = ?, service = ?, notes = ?,
          updated_at = datetime('now') WHERE id = ?`).bind(s.start_time, s.minutes, s.service, s.notes, booked.id).run();
      return json({ id: booked.id, confirmed: true }, 200);
    }
    const payRate = await defaultPayRate(env, user.email, s.client_id);
    const client = await env.DB.prepare('SELECT billing_mode FROM clients WHERE id = ?').bind(s.client_id).first();
    const row = await env.DB.prepare(`INSERT INTO sessions (tutor_email, client_id, date, start_time, minutes, service, notes, pay_rate, billing)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(user.email, s.client_id, s.date, s.start_time, s.minutes, s.service, s.notes, payRate, client.billing_mode).first();
    return json({ id: row.id }, 201);
  }

  // POST /api/my/sessions/:id/confirm { minutes?, notes? } -- it happened.
  // POST /api/my/sessions/:id/missed -- it didn't.
  if (seg.length === 3 && method === 'POST' && (seg[2] === 'confirm' || seg[2] === 'missed')) {
    const id = intParam(seg[1]);
    const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND tutor_email = ?').bind(id, user.email).first();
    if (!existing) throw new HttpError(404, 'Session not found.');
    if (existing.status !== 'scheduled') throw new HttpError(409, 'This session isn’t waiting to be confirmed.');
    if (existing.date > todayLocal()) bad('You can confirm a session on or after its day.');
    if (seg[2] === 'missed') {
      await env.DB.prepare("UPDATE sessions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    const b = await body(request);
    const minutes = b.minutes === undefined || b.minutes === null || b.minutes === '' ? existing.minutes : minutesParam(b.minutes);
    const notes = b.notes === undefined ? existing.notes : str(b.notes, 2000, 'Notes');
    await env.DB.prepare(`UPDATE sessions SET status = 'held', minutes = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(minutes, notes, id).run();
    return json({ ok: true });
  }

  if (seg.length === 2 && (method === 'PUT' || method === 'DELETE')) {
    const id = intParam(seg[1]);
    const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND tutor_email = ?').bind(id, user.email).first();
    if (!existing) throw new HttpError(404, 'Session not found.');
    if (existing.invoice_id) throw new HttpError(409, 'This session has already been invoiced. Ask a founder to change it.');
    // A booking's day, time and invitees are the founders' to change (they
    // go out as calendar invites); the tutor confirms it or marks it missed.
    if (existing.status !== 'held') throw new HttpError(409, 'This session was scheduled by a founder. Confirm it, or mark that it didn’t happen.');
    if (daysAgo(existing.date) > 31) throw new HttpError(409, "Sessions more than 31 days old can't be changed. Ask a founder to fix it.");

    if (method === 'DELETE') {
      if (existing.scheduled_by) {
        await env.DB.prepare("UPDATE sessions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(id).run();
        return json({ ok: true, cancelled: true });
      }
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    const s = sessionFields(await body(request));
    let payRate = existing.pay_rate;
    if (s.client_id !== existing.client_id) {
      if (existing.scheduled_by) bad('This session was scheduled for a particular client. Ask a founder to move it.');
      await assertCanUseClient(env, user, s.client_id);
      payRate = await defaultPayRate(env, user.email, s.client_id);
    }
    await env.DB.prepare(`UPDATE sessions SET client_id = ?, date = ?, start_time = ?, minutes = ?, service = ?, notes = ?,
        pay_rate = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(s.client_id, s.date, s.start_time, s.minutes, s.service, s.notes, payRate, id).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found.');
}

function sessionFields(b) {
  return {
    client_id: intParam(b.client_id, 'Pick a client.'),
    date: dateParam(b.date),
    start_time: timeParam(b.start_time),
    minutes: minutesParam(b.minutes),
    service: str(b.service, 60, 'Type'),
    notes: str(b.notes, 2000, 'Notes'),
  };
}

async function assertCanUseClient(env, user, clientId) {
  const row = user.role === 'founder'
    ? await env.DB.prepare('SELECT id FROM clients WHERE id = ? AND active = 1').bind(clientId).first()
    : await env.DB.prepare(`SELECT c.id FROM tutor_clients tc JOIN clients c ON c.id = tc.client_id
        WHERE tc.tutor_email = ? AND tc.client_id = ? AND c.active = 1`).bind(user.email, clientId).first();
  if (!row) throw new HttpError(403, "You're not set up to log sessions for that client.");
}

async function defaultPayRate(env, email, clientId) {
  const row = await env.DB.prepare(`SELECT COALESCE(tc.pay_rate, u.default_pay_rate) AS rate FROM users u
      LEFT JOIN tutor_clients tc ON tc.tutor_email = u.email AND tc.client_id = ? WHERE u.email = ?`)
    .bind(clientId, email).first();
  return row ? row.rate : null;
}

// ---------- founder routes (/api/admin/*) ----------

async function adminRoutes(request, env, user, seg, url) {
  const method = request.method;
  const [resource, id] = seg;
  const q = url.searchParams;

  // People
  if (resource === 'users') {
    if (!id && method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT u.email, u.name, u.role, u.default_pay_rate, u.active,
          (SELECT COUNT(*) FROM sessions s WHERE s.tutor_email = u.email) AS session_count,
          (SELECT COUNT(*) FROM sessions s WHERE s.tutor_email = u.email AND s.invoice_id IS NOT NULL) AS invoiced_count
        FROM users u ORDER BY u.role, u.name, u.email`).all();
      return json(results);
    }
    if (!id && method === 'POST') {
      const b = await body(request);
      const email = str(b.email, 200, 'Email').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email.');
      const role = b.role === 'founder' ? 'founder' : 'tutor';
      const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
      if (exists) throw new HttpError(409, 'That person is already on the list.');
      await env.DB.prepare('INSERT INTO users (email, name, role, default_pay_rate) VALUES (?, ?, ?, ?)')
        .bind(email, str(b.name, 120, 'Name'), role, rateParam(b.default_pay_rate)).run();
      return json({ ok: true }, 201);
    }
    if (id && method === 'PUT') {
      const email = decodeURIComponent(id).toLowerCase();
      const b = await body(request);
      const role = b.role === 'founder' ? 'founder' : 'tutor';
      const active = b.active ? 1 : 0;
      if (email === user.email && (role !== 'founder' || !active)) bad("You can't remove your own founder access.");
      const r = await env.DB.prepare('UPDATE users SET name = ?, role = ?, default_pay_rate = ?, active = ? WHERE email = ?')
        .bind(str(b.name, 120, 'Name'), role, rateParam(b.default_pay_rate), active, email).run();
      if (!r.meta.changes) throw new HttpError(404, 'Person not found.');
      return json({ ok: true });
    }
    // Deleting a person also deletes their uninvoiced sessions and client
    // assignments. Invoiced sessions back a financial record, so anyone with one
    // can only be marked inactive — same rule as deleting a client.
    if (id && method === 'DELETE') {
      const email = decodeURIComponent(id).toLowerCase();
      if (email === user.email) bad("You can't delete yourself.");
      // A FOUNDER_EMAILS founder would just be re-created on their next sign-in.
      const founders = (env.FOUNDER_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
      if (founders.includes(email)) bad('This founder is set in the site config, so they can’t be deleted here.');
      const inv = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tutor_email = ? AND invoice_id IS NOT NULL').bind(email).first();
      if (inv.n) throw new HttpError(409, 'This person has invoiced sessions, so they can’t be deleted. Untick Active instead.');
      const [sess, , del] = await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE tutor_email = ?').bind(email),
        env.DB.prepare('DELETE FROM tutor_clients WHERE tutor_email = ?').bind(email),
        env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email),
      ]);
      if (!del.meta.changes) throw new HttpError(404, 'Person not found.');
      return json({ ok: true, sessions_deleted: sess.meta.changes });
    }
  }

  // Clients (with their tutor assignments)
  if (resource === 'clients') {
    if (!id && method === 'GET') {
      const today = todayLocal();
      const [{ results: clients }, { results: links }, { results: packages }, { results: docs }, { results: contracts }] = await env.DB.batch([
        env.DB.prepare(`SELECT c.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.client_id = c.id) AS session_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.client_id = c.id AND s.status = 'held') AS held_count,
            (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id) AS invoice_count,
            (SELECT COALESCE(SUM(p.sessions), 0) FROM packages p WHERE p.client_id = c.id) AS package_sessions,
            (SELECT COUNT(*) FROM sessions s WHERE s.client_id = c.id AND s.billing = 'paid' AND s.status != 'cancelled') AS paid_used,
            (SELECT MAX(s.date) FROM sessions s WHERE s.client_id = c.id AND s.status = 'held') AS last_session,
            (SELECT MIN(s.date || ' ' || s.start_time) FROM sessions s WHERE s.client_id = c.id AND s.status = 'scheduled' AND s.date >= ?1) AS next_session,
            (SELECT st.email FROM students st WHERE c.student_email = '' AND c.student != '' AND lower(st.name) = lower(c.student) LIMIT 1) AS suggested_student_email
          FROM clients c ORDER BY c.active DESC, c.name`).bind(today),
        env.DB.prepare('SELECT tutor_email, client_id, pay_rate, client_rate FROM tutor_clients'),
        env.DB.prepare('SELECT * FROM packages ORDER BY purchased_on DESC, id DESC'),
        env.DB.prepare('SELECT id, client_id, title, url, created_at FROM client_links ORDER BY created_at, id'),
        env.DB.prepare('SELECT id, client_id, title, created_at FROM contracts ORDER BY created_at DESC'),
      ]);
      const founders = clients.some(c => c.is_test) ? await founderEmails(env) : [];
      for (const c of clients) {
        if (c.is_test) c.test_emails = founders;
        c.tutors = links.filter(l => l.client_id === c.id);
        c.packages = packages.filter(p => p.client_id === c.id);
        c.docs = docs.filter(d => d.client_id === c.id);
        c.contracts = contracts.filter(k => k.client_id === c.id);
        c.package_left = c.package_sessions - c.paid_used;
      }
      return json(clients);
    }
    if (method === 'POST' || method === 'PUT') {
      const b = await body(request);
      const name = str(b.name, 120, 'Client name');
      if (!name) bad('Client name is required.');
      const defaultRate = rateParam(b.default_rate);
      if (defaultRate === null) bad('Set a default rate for this client.');
      const vals = [name, str(b.student, 120, 'Student'), emailParam(b.billing_email, 'Billing email'),
        emailParam(b.student_email, 'Student email'), str(b.location, 200, 'Location'), defaultRate, str(b.notes, 1000, 'Notes'),
        b.billing_mode === 'paid' ? 'paid' : 'billable', str(b.summary, 4000, 'Rundown')];
      if (method === 'POST' && !id) {
        const row = await env.DB.prepare(`INSERT INTO clients (name, student, billing_email, student_email, location, default_rate, notes, billing_mode, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(...vals).first();
        return json({ id: row.id }, 201);
      }
      if (method === 'PUT' && id) {
        const r = await env.DB.prepare(`UPDATE clients SET name = ?, student = ?, billing_email = ?, student_email = ?, location = ?, default_rate = ?,
            notes = ?, billing_mode = ?, summary = ?, active = ? WHERE id = ?`).bind(...vals, b.active ? 1 : 0, intParam(id)).run();
        if (!r.meta.changes) throw new HttpError(404, 'Client not found.');
        return json({ ok: true });
      }
    }
    // Deleting a client also deletes their (necessarily uninvoiced) sessions and
    // tutor assignments. Invoices are financial records, so a client with any
    // invoice — even a void one — can only be marked inactive, never deleted.
    if (id && method === 'DELETE') {
      const clientId = intParam(id);
      const inv = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE client_id = ?').bind(clientId).first();
      if (inv.n) throw new HttpError(409, 'This client has invoices, so they can’t be deleted. Untick Active instead.');
      const [sess, , , , , del] = await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM tutor_clients WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM packages WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM client_links WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM contracts WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(clientId),
      ]);
      if (!del.meta.changes) throw new HttpError(404, 'Client not found.');
      return json({ ok: true, sessions_deleted: sess.meta.changes });
    }
  }

  // PUT /api/admin/client-fields/:id { summary?, student_email?, active? } --
  // the Students directory edits one thing at a time.
  if (resource === 'client-fields' && id && method === 'PUT') {
    const b = await body(request);
    const sets = [], binds = [];
    if (b.summary !== undefined) { sets.push('summary = ?'); binds.push(str(b.summary, 4000, 'Rundown')); }
    if (b.student_email !== undefined) { sets.push('student_email = ?'); binds.push(emailParam(b.student_email, 'Student email')); }
    if (b.active !== undefined) { sets.push('active = ?'); binds.push(b.active ? 1 : 0); }
    if (b.billing_mode !== undefined) { sets.push('billing_mode = ?'); binds.push(b.billing_mode === 'paid' ? 'paid' : 'billable'); }
    if (!sets.length) bad('Nothing to change.');
    const r = await env.DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, intParam(id)).run();
    if (!r.meta.changes) throw new HttpError(404, 'Client not found.');
    return json({ ok: true });
  }

  // Prepaid packages
  if (resource === 'packages') {
    if (!id && method === 'POST') {
      const b = await body(request);
      const clientId = intParam(b.client_id, 'Pick a client.');
      const n = Number(b.sessions);
      if (!Number.isInteger(n) || n < 1 || n > 500) bad('A package is 1 to 500 sessions.');
      const amount = b.amount === '' || b.amount === null || b.amount === undefined ? null : rateParam(b.amount);
      const row = await env.DB.prepare(`INSERT INTO packages (client_id, sessions, purchased_on, amount, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(clientId, n, dateParam(b.purchased_on), amount, str(b.notes, 300, 'Notes'), user.email).first();
      return json({ id: row.id }, 201);
    }
    if (id && method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM packages WHERE id = ?').bind(intParam(id)).run();
      if (!r.meta.changes) throw new HttpError(404, 'Package not found.');
      return json({ ok: true });
    }
  }

  // A student's working docs: { client_id, title, url }.
  if (resource === 'client-links') {
    if (!id && method === 'POST') {
      const b = await body(request);
      const clientId = intParam(b.client_id, 'Pick a client.');
      const url = str(b.url, 1000, 'Link');
      if (!/^https:\/\/\S+$/.test(url)) bad('Paste a full link starting with https://');
      const title = str(b.title, 200, 'Title') || linkTitle(url);
      const row = await env.DB.prepare('INSERT INTO client_links (client_id, title, url, added_by) VALUES (?, ?, ?, ?) RETURNING id')
        .bind(clientId, title, url, user.email).first();
      return json({ id: row.id }, 201);
    }
    if (id && method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM client_links WHERE id = ?').bind(intParam(id)).run();
      if (!r.meta.changes) throw new HttpError(404, 'Link not found.');
      return json({ ok: true });
    }
  }

  // Agreements saved from /contract: POST { client_id, title, form, html }.
  if (resource === 'contracts') {
    if (!id && method === 'POST') {
      const b = await body(request);
      const clientId = intParam(b.client_id, 'Pick a client.');
      if (!(await env.DB.prepare('SELECT 1 FROM clients WHERE id = ?').bind(clientId).first())) bad('Client not found.');
      const html = typeof b.html === 'string' ? b.html : '';
      if (!html.trim() || html.length > 900000) bad('The agreement is empty or too large to save.');
      const form = JSON.stringify(b.form && typeof b.form === 'object' ? b.form : {});
      if (form.length > 20000) bad('The agreement details are too large to save.');
      const cid = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO contracts (id, client_id, title, form, html, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(cid, clientId, str(b.title, 200, 'Title') || 'Agreement', form, html, user.email).run();
      return json({ id: cid }, 201);
    }
    if (id && method === 'GET') {
      const row = await env.DB.prepare(`SELECT k.*, c.name AS client_name, c.student FROM contracts k JOIN clients c ON c.id = k.client_id
          WHERE k.id = ?`).bind(id).first();
      if (!row) throw new HttpError(404, 'Agreement not found.');
      return json({ ...row, form: JSON.parse(row.form || '{}') });
    }
    if (id && method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM contracts WHERE id = ?').bind(id).run();
      if (!r.meta.changes) throw new HttpError(404, 'Agreement not found.');
      return json({ ok: true });
    }
  }

  // POST /api/admin/schedule -- book one or many sessions (see scheduleSessions).
  if (resource === 'schedule' && !id && method === 'POST') return scheduleSessions(env, user, await body(request));

  // Tutor <-> client assignment and per-pair rates
  if (resource === 'assignments' && !id && method === 'PUT') {
    const b = await body(request);
    const email = str(b.tutor_email, 200, 'Tutor').toLowerCase();
    const clientId = intParam(b.client_id);
    if (b.assigned) {
      await env.DB.prepare(`INSERT INTO tutor_clients (tutor_email, client_id, pay_rate, client_rate) VALUES (?, ?, ?, ?)
          ON CONFLICT (tutor_email, client_id) DO UPDATE SET pay_rate = excluded.pay_rate, client_rate = excluded.client_rate`)
        .bind(email, clientId, rateParam(b.pay_rate), rateParam(b.client_rate)).run();
    } else {
      await env.DB.prepare('DELETE FROM tutor_clients WHERE tutor_email = ? AND client_id = ?').bind(email, clientId).run();
    }
    return json({ ok: true });
  }

  // All sessions
  if (resource === 'sessions') {
    if (!id && method === 'GET') {
      const where = [];
      const binds = [];
      if (q.get('month')) { where.push('substr(s.date, 1, 7) = ?'); binds.push(monthParam(q.get('month'))); }
      if (q.get('tutor')) { where.push('s.tutor_email = ?'); binds.push(q.get('tutor').toLowerCase()); }
      if (q.get('client')) { where.push('s.client_id = ?'); binds.push(intParam(q.get('client'))); }
      // "uninvoiced" is what an invoice can take: held, BILLABLE, not billed yet.
      const st = q.get('status');
      if (st === 'uninvoiced') where.push("s.invoice_id IS NULL AND s.status = 'held' AND s.billing = 'billable'");
      if (st === 'invoiced') where.push('s.invoice_id IS NOT NULL');
      if (st === 'held') where.push("s.status = 'held'");
      if (st === 'scheduled') where.push("s.status = 'scheduled'");
      if (st === 'unconfirmed') { where.push("s.status = 'scheduled' AND s.date < ?"); binds.push(todayLocal()); }
      if (st === 'upcoming') { where.push("s.status = 'scheduled' AND s.date >= ?"); binds.push(todayLocal()); }
      if (st === 'cancelled') where.push("s.status = 'cancelled'");
      if (q.get('billing') === 'paid' || q.get('billing') === 'billable') { where.push('s.billing = ?'); binds.push(q.get('billing')); }
      if (q.get('from')) { where.push('s.date >= ?'); binds.push(dateParam(q.get('from'))); }
      const { results } = await env.DB.prepare(`SELECT s.*, u.name AS tutor_name, c.name AS client_name, c.student,
          c.billing_email, c.student_email, c.is_test AS test,
          COALESCE(s.client_rate, tc.client_rate, c.default_rate) AS bill_rate, i.number AS invoice_number
          FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id
          LEFT JOIN tutor_clients tc ON tc.tutor_email = s.tutor_email AND tc.client_id = s.client_id
          LEFT JOIN invoices i ON i.id = s.invoice_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY s.date, s.start_time, s.id`).bind(...binds).all();
      return json(results);
    }
    if (id && method === 'PUT') {
      const sid = intParam(id);
      const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sid).first();
      if (!existing) throw new HttpError(404, 'Session not found.');
      const b = await body(request);
      if (existing.invoice_id) {
        // Invoiced sessions are frozen for billing, but pay can still be corrected.
        await env.DB.prepare("UPDATE sessions SET pay_rate = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(rateParam(b.pay_rate), sid).run();
        return json({ ok: true });
      }
      const before = existing.status === 'scheduled' && existing.cal_uid ? await sessionForInvite(env, sid) : null;
      const s = sessionFields(b);
      const billing = b.billing === undefined ? existing.billing : b.billing === 'paid' ? 'paid' : 'billable';
      const tutor = b.tutor_email ? str(b.tutor_email, 200, 'Tutor').toLowerCase() : existing.tutor_email;
      if (tutor !== existing.tutor_email && !(await env.DB.prepare('SELECT 1 FROM users WHERE email = ? AND active = 1').bind(tutor).first())) bad('Pick an active tutor.');
      await env.DB.prepare(`UPDATE sessions SET tutor_email = ?, client_id = ?, date = ?, start_time = ?, minutes = ?, service = ?, notes = ?,
          pay_rate = ?, billing = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(tutor, s.client_id, s.date, s.start_time, s.minutes, s.service, s.notes, rateParam(b.pay_rate), billing, sid).run();
      // A booking that moved (or changed hands) sends everyone an updated invite.
      let invites = null;
      const moved = ['tutor_email', 'client_id', 'date', 'start_time', 'minutes']
        .some(k => String(existing[k]) !== String({ ...s, tutor_email: tutor }[k]));
      if (before && moved && b.send_invites !== false) {
        if (tutor !== existing.tutor_email) await sendInvite(env, before, 'cancel', [existing.tutor_email]);
        invites = await sendInvite(env, await sessionForInvite(env, sid), 'request');
      }
      return json({ ok: true, invites });
    }
    // POST /api/admin/sessions/:id/status { status: 'held' | 'cancelled' | 'scheduled' }
    if (id && seg[2] === 'status' && method === 'POST') {
      const sid = intParam(id);
      const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sid).first();
      if (!existing) throw new HttpError(404, 'Session not found.');
      if (existing.invoice_id) throw new HttpError(409, 'This session is on an invoice. Void the invoice first.');
      const status = (await body(request)).status;
      if (!['held', 'cancelled', 'scheduled'].includes(status)) bad('Unknown status.');
      if (status === 'held' && existing.date > todayLocal()) bad('A session can be marked held on or after its day.');
      if (status === 'scheduled' && !existing.start_time) bad('Give the session a start time before scheduling it.');
      await env.DB.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, sid).run();
      // Calling off a booking that hasn't happened yet takes it off everyone's calendar.
      let invites = null;
      if (status === 'cancelled' && existing.status === 'scheduled' && existing.cal_uid && existing.date >= todayLocal()) {
        invites = await sendInvite(env, await sessionForInvite(env, sid), 'cancel');
      }
      return json({ ok: true, invites });
    }
    // POST /api/admin/sessions/:id/invite -- send (or resend) the calendar invite.
    if (id && seg[2] === 'invite' && method === 'POST') {
      const sess = await sessionForInvite(env, intParam(id));
      if (!sess) throw new HttpError(404, 'Session not found.');
      if (sess.status !== 'scheduled') bad('Only upcoming scheduled sessions get invites.');
      return json({ ok: true, invites: await sendInvite(env, sess, 'request') });
    }
    if (id && method === 'DELETE') {
      const sid = intParam(id);
      const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sid).first();
      if (existing && existing.status === 'scheduled' && existing.cal_uid && existing.date >= todayLocal() && !existing.invoice_id) {
        await sendInvite(env, await sessionForInvite(env, sid), 'cancel');
      }
      const r = await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND invoice_id IS NULL').bind(sid).run();
      if (!r.meta.changes) throw new HttpError(409, 'Void the invoice first, or the session no longer exists.');
      return json({ ok: true });
    }
  }

  // GET /api/admin/tax?year=2026 -- what each tutor was paid in a year, for 1099-NEC.
  if (resource === 'tax' && !id && method === 'GET') {
    const year = String(q.get('year') || '');
    if (!/^20\d\d$/.test(year)) bad('Pick a year.');
    const { results } = await env.DB.prepare(`SELECT s.tutor_email, u.name, u.role, COUNT(*) AS sessions, SUM(s.minutes) AS minutes,
        SUM(CASE WHEN s.pay_rate IS NULL THEN 0 ELSE ROUND(s.pay_rate * s.minutes / 60.0, 2) END) AS pay,
        SUM(CASE WHEN s.pay_rate IS NULL THEN 1 ELSE 0 END) AS missing
        FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id
        WHERE s.status = 'held' AND c.is_test = 0 AND substr(s.date, 1, 4) = ? GROUP BY s.tutor_email ORDER BY u.name, s.tutor_email`).bind(year).all();
    // The 1099-NEC threshold: $600 through 2025, $2,000 from 2026 (2025's
    // tax law change; indexed for inflation after 2026 -- check each year).
    return json({ year, threshold: Number(year) >= 2026 ? 2000 : 600, tutors: results.map(r => ({ ...r, pay: round2(r.pay || 0) })) });
  }

  // Invoices
  if (resource === 'invoices') {
    if (!id && method === 'GET') {
      const month = q.get('month') ? monthParam(q.get('month')) : null;
      const { results } = await env.DB.prepare(`SELECT i.*, c.name AS client_name, c.is_test AS test FROM invoices i JOIN clients c ON c.id = i.client_id
          ${month ? 'WHERE i.period = ?' : ''} ORDER BY i.created_at DESC`).bind(...(month ? [month] : [])).all();
      return json(results);
    }
    if (id && method === 'GET') {
      const inv = await env.DB.prepare(`SELECT i.*, c.billing_email FROM invoices i JOIN clients c ON c.id = i.client_id
          WHERE i.id = ?`).bind(id).first();
      if (!inv) throw new HttpError(404, 'Invoice not found.');
      const { results } = await env.DB.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort').bind(id).all();
      inv.lines = results;
      try { inv.ov = JSON.parse(inv.overrides || '{}'); } catch { inv.ov = {}; }
      delete inv.overrides;
      return json(inv);
    }
    if (!id && method === 'POST') return createInvoice(env, user, await body(request));
    if (id === 'generate-all' && method === 'POST') {
      const b = await body(request);
      const result = await generateAllInvoices(env, user, monthParam(b.period), {
        issued_date: dateParam(b.issued_date), due_text: str(b.due_text, 120, 'Payment due'), llc: !!b.llc,
      });
      return json(result, 201);
    }
    // POST /api/admin/invoices/:id/email -- send it to the client, CC the founders.
    if (id && seg[2] === 'email' && method === 'POST') return emailInvoice(env, id);
    // DELETE removes the invoice and its lines outright (any status), and frees
    // its sessions to be billed again. Its number is still never reused.
    if (id && method === 'DELETE') {
      const [, , del] = await env.DB.batch([
        env.DB.prepare('UPDATE sessions SET invoice_id = NULL, client_rate = NULL WHERE invoice_id = ?').bind(id),
        env.DB.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').bind(id),
        env.DB.prepare('DELETE FROM invoices WHERE id = ?').bind(id),
      ]);
      if (!del.meta.changes) throw new HttpError(404, 'Invoice not found.');
      return json({ ok: true });
    }
    if (id && method === 'PUT') {
      const b = await body(request);
      const inv = await env.DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(id).first();
      if (!inv) throw new HttpError(404, 'Invoice not found.');
      if (inv.status === 'void') bad('This invoice was voided.');
      if (b.status === 'void') {
        // Frees its sessions so they can go on a corrected invoice. The number is never reused.
        await env.DB.batch([
          env.DB.prepare('UPDATE sessions SET invoice_id = NULL, client_rate = NULL WHERE invoice_id = ?').bind(id),
          env.DB.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").bind(id),
        ]);
        return json({ ok: true });
      }
      if (!['draft', 'sent', 'paid'].includes(b.status)) bad('Unknown status.');
      await env.DB.prepare('UPDATE invoices SET status = ? WHERE id = ?').bind(b.status, id).run();
      return json({ ok: true });
    }
  }

  // Weekly dashboard (/dashboard)
  if (resource === 'dashboard' && !id && method === 'GET') return dashboard(env, q.get('week'));
  if (resource === 'docket') {
    if (!id && method === 'POST') {
      const f = docketFields(await body(request));
      const r = await env.DB.prepare(`INSERT INTO docket (kind, owner, title, detail, url, due, client_id, amount, source, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`)
        .bind(f.kind, f.owner, f.title, f.detail, f.url, f.due, f.client_id, f.amount, user.email).run();
      return json({ ok: true, id: r.meta.last_row_id }, 201);
    }
    if (id && method === 'PUT') {
      const b = await body(request);
      const item = await env.DB.prepare('SELECT * FROM docket WHERE id = ?').bind(intParam(id)).first();
      if (!item) throw new HttpError(404, 'Item not found.');
      // Only the fields sent change, so ticking an item off doesn't need the whole item.
      const f = docketFields({ ...item, ...b });
      const status = b.status === undefined ? item.status : b.status;
      if (!['open', 'done', 'dismissed'].includes(status)) bad('Unknown status.');
      const closing = status !== 'open' && item.status === 'open';
      await env.DB.prepare(`UPDATE docket SET kind = ?, owner = ?, title = ?, detail = ?, url = ?, due = ?, client_id = ?, amount = ?,
          status = ?, done_by = ?, done_at = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(f.kind, f.owner, f.title, f.detail, f.url, f.due, f.client_id, f.amount, status,
          status === 'open' ? null : closing ? user.email : item.done_by,
          status === 'open' ? null : closing ? todayLocal() + ' ' + nowClock() : item.done_at, item.id).run();
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM docket WHERE id = ?').bind(intParam(id)).run();
      if (!r.meta.changes) throw new HttpError(404, 'Item not found.');
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- weekly dashboard ----------

const DOCKET_KINDS = ['meeting', 'doc', 'payment', 'reply', 'task'];

function docketFields(b) {
  if (!DOCKET_KINDS.includes(b.kind)) bad('Unknown kind.');
  const due = String(b.due ?? '').trim();
  if (due && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(due)) bad('Use a date like 2026-10-12, optionally with a time (2026-10-12 16:00).');
  const url = String(b.url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) bad('Links must start with http:// or https://.');
  const amount = b.amount === null || b.amount === undefined || b.amount === '' ? null : Number(b.amount);
  if (amount !== null && !Number.isFinite(amount)) bad('Amount must be a number.');
  return {
    kind: b.kind,
    owner: String(b.owner ?? '').trim().toLowerCase(),
    title: str(b.title, 300, 'Title') || bad('Give it a title.'),
    detail: String(b.detail ?? '').slice(0, 4000),
    url: url.slice(0, 1000),
    due,
    client_id: b.client_id ? intParam(b.client_id) : null,
    amount,
  };
}

// HH:MM now, New York time (dates and times in the docket are wall-clock, like sessions).
const nowClock = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

// Monday of the week holding `iso` (YYYY-MM-DD).
function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function plusDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Everything on the docket for one week (Monday to Sunday). The current week
// shows every open item, whatever its date (a doc due next Monday is this
// week's work); other weeks show what was due in them. Items closed during a
// week stay on it, ticked off, so a past week reads as a record. The TEST client is left out, as in every real total.
async function dashboard(env, week) {
  const start = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : todayLocal());
  const end = plusDays(start, 6);
  const isCurrent = start === mondayOf(todayLocal()) ? 1 : 0;
  const [{ results: items }, { results: sessions }, { results: invoices }, { results: founders }, { results: crawls }, { results: clients }, { results: links }] = await env.DB.batch([
    env.DB.prepare(`SELECT d.*, c.name AS client_name, c.student FROM docket d LEFT JOIN clients c ON c.id = d.client_id
        WHERE (c.is_test IS NULL OR c.is_test = 0) AND (
          (d.status = 'open' AND ?3)
          OR substr(d.due, 1, 10) BETWEEN ?1 AND ?2
          OR (d.status != 'open' AND substr(d.done_at, 1, 10) BETWEEN ?1 AND ?2))
        ORDER BY d.due = '', d.due, d.id`).bind(start, end, isCurrent),
    env.DB.prepare(`SELECT s.id, s.date, s.start_time, s.minutes, s.status, s.service, s.notes, s.tutor_email, u.name AS tutor_name,
          c.id AS client_id, c.name AS client_name, c.student, c.summary, c.location
        FROM sessions s JOIN clients c ON c.id = s.client_id JOIN users u ON u.email = s.tutor_email
        WHERE s.date BETWEEN ? AND ? AND s.status != 'cancelled' AND c.is_test = 0
        ORDER BY s.date, s.start_time`).bind(start, end),
    env.DB.prepare(`SELECT i.id, i.number, i.period, i.issued_date, i.total, i.status, i.emailed_at, i.bill_to, i.student, c.name AS client_name
        FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE i.status IN ('draft', 'sent') AND c.is_test = 0 ORDER BY i.issued_date, i.number`),
    env.DB.prepare("SELECT email, name FROM users WHERE role = 'founder' AND active = 1 ORDER BY name"),
    env.DB.prepare("SELECT key, value FROM config WHERE key LIKE 'docket_crawled:%'"),
    env.DB.prepare('SELECT id, name, student FROM clients WHERE active = 1 AND is_test = 0 ORDER BY student, name'),
    env.DB.prepare('SELECT client_id, title, url FROM client_links ORDER BY id'),
  ]);
  // Meetings carry their student's docs and rundown, for prep.
  const docsBy = {};
  for (const l of links) (docsBy[l.client_id] ||= []).push({ title: l.title, url: l.url });
  for (const s of sessions) s.docs = docsBy[s.client_id] || [];
  for (const i of items) if (i.client_id) i.docs = docsBy[i.client_id] || [];
  return json({
    week_start: start, week_end: end, today: todayLocal(),
    items, sessions, invoices, founders, clients,
    crawled: crawls.map(r => ({ email: r.key.slice('docket_crawled:'.length), at: r.value })),
  });
}

async function createInvoice(env, user, b) {
  const clientId = intParam(b.client_id, 'Pick a client.');
  const period = monthParam(b.period);
  const issued = dateParam(b.issued_date);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) bad('Client not found.');

  const reqLines = Array.isArray(b.lines) ? b.lines : [];
  const extras = Array.isArray(b.extras) ? b.extras : [];
  if (!reqLines.length && !extras.length) bad('Add at least one session or line item.');
  if (reqLines.length > 200 || extras.length > 100) bad('Too many lines.');

  const ids = reqLines.map(l => intParam(l.session_id));
  if (new Set(ids).size !== ids.length) bad('A session is listed twice.');
  let sessions = [];
  if (ids.length) {
    ({ results: sessions } = await env.DB.prepare(`SELECT * FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids).all());
  }
  const byId = new Map(sessions.map(s => [s.id, s]));

  const lines = [];
  for (const l of reqLines) {
    const s = byId.get(Number(l.session_id));
    if (!s || s.client_id !== clientId) bad('One of the sessions does not belong to this client.');
    if (s.invoice_id) bad(`The ${s.date} session is already on another invoice.`);
    if (s.status !== 'held') bad(`The ${s.date} session hasn't been confirmed as held yet.`);
    if (s.billing !== 'billable') bad(`The ${s.date} session is PAID from a package, so it isn't billed.`);
    const rate = rateParam(l.rate);
    if (rate === null) bad(`Set a rate for the ${s.date} session.`);
    // Billed length can differ from the logged length (e.g. rounding up); the
    // session's own minutes, which drive tutor pay, are left untouched.
    const minutes = l.minutes === undefined || l.minutes === null ? s.minutes : billedMinutes(l.minutes, `the ${s.date} session`);
    lines.push({
      session_id: s.id, date: s.date, minutes, rate,
      description: str(l.description, 200, 'Description') || s.service || 'Tutoring session',
      amount: amountOverride(l.amount) ?? round2(rate * minutes / 60),
    });
  }
  // Manual lines are either hourly (hours × rate) or a flat amount (fees, packages,
  // discounts as negatives). The date is optional.
  for (const e of extras) {
    const description = str(e.description, 200, 'Line item');
    if (!description) bad('Each extra line needs a description.');
    const date = e.date ? dateParam(e.date) : '';
    const minutes = e.minutes === undefined || e.minutes === null || e.minutes === '' ? null : billedMinutes(e.minutes, `"${description}"`);
    const rate = minutes ? rateParam(e.rate) : null;
    let amount;
    if (amountOverride(e.amount) !== null) amount = amountOverride(e.amount);
    else if (minutes && rate !== null) amount = round2(rate * minutes / 60);
    else {
      amount = Number(e.amount);
      if (e.amount === '' || e.amount === null || !Number.isFinite(amount) || Math.abs(amount) > 100000)
        bad(`Give "${description}" an amount, or hours and a rate.`);
      amount = round2(amount);
    }
    lines.push({ session_id: null, date, minutes, rate, description, amount });
  }
  // Dated lines in date order, undated ones (fees, discounts) after them.
  lines.sort((a, b2) => (!a.date) - (!b2.date) || a.date.localeCompare(b2.date));
  const saved = await saveInvoice(env, user, client, period, issued, str(b.due_text, 120, 'Payment due'), !!b.llc, str(b.notes, 1000, 'Notes'), lines, overridesParam(b.overrides));
  return json(saved, 201);
}

// A line's amount typed directly on the invoice, replacing hours x rate. null = not overridden.
function amountOverride(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 100000) bad('Line amounts must be between -$100,000 and $100,000.');
  return round2(n);
}

// Text edited directly on the invoice document. Only known keys are kept; the four
// that have their own columns are split out, the rest is stored as JSON.
const COLUMN_OVERRIDES = ['bill_to', 'student', 'from_line', 'number'];
function overridesParam(o) {
  const out = { columns: {}, extra: {}, total: null };
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'total') { out.total = amountOverride(v); continue; }
    if (!/^[a-z_]{1,32}$/.test(k) || typeof v !== 'string') continue;
    const t = str(v, 2000, 'Invoice text');
    (COLUMN_OVERRIDES.includes(k) ? out.columns : out.extra)[k] = t;
  }
  return out;
}

// The next number after the highest one ever issued under `prefix` -- the
// highest still saved, or the last one recorded in `config` (which remembers
// numbers of invoices since deleted). Returns the number and the statement
// that records it, to run in the same batch as the insert.
async function nextNumber(env, prefix) {
  const key = 'last_invoice_number:' + prefix;
  const [{ results: [saved] }, { results: [seen] }] = await env.DB.batch([
    env.DB.prepare('SELECT MAX(CAST(substr(number, ?) AS INTEGER)) AS n FROM invoices WHERE number LIKE ?').bind(prefix.length + 1, prefix + '%'),
    env.DB.prepare('SELECT CAST(value AS INTEGER) AS n FROM config WHERE key = ?').bind(key),
  ]);
  const n = Math.max(saved?.n || 0, seen?.n || 0) + 1;
  return {
    number: prefix + String(n).padStart(2, '0'),
    record: env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, String(n)),
  };
}

// Shared by the manual builder and "Generate all invoices". One batch = one
// transaction: the invoice, its lines and the session links land together or not at all.
async function saveInvoice(env, user, client, period, issued, dueText, llc, notes, lines, ov = { columns: {}, extra: {}, total: null }) {
  const total = ov.total ?? round2(lines.reduce((sum, l) => sum + l.amount, 0));
  // A number typed on the invoice is used as is (and doesn't advance the series); otherwise
  // TEST client invoices get their own TEST-… series, so they never take a real number.
  let number = ov.columns.number, record = null;
  if (number) {
    if (await env.DB.prepare('SELECT 1 FROM invoices WHERE number = ?').bind(number).first()) bad(`Invoice number ${number} is already used.`);
  } else {
    ({ number, record } = await nextNumber(env, (client.is_test ? 'TEST-' : 'PW-') + period.replace('-', '') + '-'));
  }
  const billTo = ov.columns.bill_to || client.name;
  const student = ov.columns.student ?? client.student;
  const fromLine = ov.columns.from_line || (llc ? 'Palisade Writers LLC' : 'Palisade Writers');
  const invoiceId = crypto.randomUUID();
  const stmts = [
    ...(record ? [record] : []),
    env.DB.prepare(`INSERT INTO invoices (id, number, client_id, period, issued_date, due_text, bill_to, student, from_line, notes, total, created_by, overrides)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(invoiceId, number, client.id, period, issued, dueText, billTo, student,
        fromLine, notes, total, user.email, JSON.stringify(ov.extra)),
    ...lines.map((l, i) => env.DB.prepare(`INSERT INTO invoice_lines (invoice_id, session_id, date, description, minutes, rate, amount, sort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(invoiceId, l.session_id, l.date, l.description, l.minutes, l.rate, l.amount, i)),
    ...lines.filter(l => l.session_id).map(l => env.DB.prepare(
      'UPDATE sessions SET invoice_id = ?, client_rate = ? WHERE id = ? AND invoice_id IS NULL').bind(invoiceId, l.rate, l.session_id)),
  ];
  await env.DB.batch(stmts);
  return { id: invoiceId, number, total };
}

const firstName = s => (s || '').split(/\s+/)[0];

// One invoice per active client with uninvoiced sessions in `period`. A client whose
// sessions are missing a bill rate is skipped and reported, rather than guessing a number.
async function generateAllInvoices(env, user, period, { issued_date, due_text, llc }) {
  const { results: clients } = await env.DB.prepare('SELECT * FROM clients WHERE active = 1 ORDER BY name').all();
  const created = [], skipped = [];
  for (const client of clients) {
    const { results: sessions } = await env.DB.prepare(`SELECT s.*, u.name AS tutor_name,
        COALESCE(s.client_rate, tc.client_rate, c.default_rate) AS bill_rate
        FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id
        LEFT JOIN tutor_clients tc ON tc.tutor_email = s.tutor_email AND tc.client_id = s.client_id
        WHERE s.client_id = ? AND substr(s.date, 1, 7) = ? AND s.invoice_id IS NULL
          AND s.status = 'held' AND s.billing = 'billable'
        ORDER BY s.date`).bind(client.id, period).all();
    if (!sessions.length) continue;
    const missing = sessions.find(s => s.bill_rate === null);
    if (missing) { skipped.push({ name: client.name, reason: 'No rate configured for one or more sessions.' }); continue; }
    const lines = sessions.map(s => ({
      session_id: s.id, date: s.date, minutes: s.minutes, rate: s.bill_rate,
      description: (s.service || 'Tutoring session') + ' with ' + firstName(s.tutor_name || s.tutor_email),
      amount: round2(s.bill_rate * s.minutes / 60),
    }));
    const saved = await saveInvoice(env, user, client, period, issued_date, due_text, llc, '', lines);
    created.push({ client_id: client.id, name: client.name, number: saved.number, total: saved.total, test: !!client.is_test });
  }
  return { created, skipped };
}

// Read-only, unlocked snapshot of pay owed per tutor for `period` — for the monthly
// email only. Pay stubs themselves are generated on demand from live data (see
// invoice.html), never persisted, so there's nothing to "generate" here to save.
async function computeMonthlyPayroll(env, period) {
  const { results: sessions } = await env.DB.prepare(`SELECT s.tutor_email, s.pay_rate, s.minutes, u.name AS tutor_name
      FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id
      WHERE substr(s.date, 1, 7) = ? AND s.status = 'held' AND c.is_test = 0`).bind(period).all();
  const byTutor = new Map();
  for (const s of sessions) {
    const t = byTutor.get(s.tutor_email) || { name: s.tutor_name || s.tutor_email, pay: 0, missing: 0 };
    if (s.pay_rate === null) t.missing++; else t.pay += round2(s.pay_rate * s.minutes / 60);
    byTutor.set(s.tutor_email, t);
  }
  return [...byTutor.values()];
}

// ---------- scheduling & calendar invites ----------

// POST /api/admin/schedule { tutor_email, client_id, dates: [YYYY-MM-DD], start_time,
//   minutes, service, notes, billing: 'billable' | 'paid', send_invites }
// Books a session on each date. Invites go to the parent (billing email), the
// student (if we have their email -- not having it never blocks booking) and
// the tutor, from CALENDAR_ORGANIZER.
async function scheduleSessions(env, user, b) {
  const clientId = intParam(b.client_id, 'Pick a client.');
  const tutor = str(b.tutor_email, 200, 'Tutor').toLowerCase();
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').bind(clientId).first();
  if (!client) bad('Pick an active client.');
  if (!(await env.DB.prepare('SELECT 1 FROM users WHERE email = ? AND active = 1').bind(tutor).first())) bad('Pick an active tutor.');
  const start_time = timeParam(b.start_time);
  if (!start_time) bad('Give the sessions a start time.');
  const minutes = minutesParam(b.minutes);
  const service = str(b.service, 60, 'Type') || 'Tutoring session';
  const notes = str(b.notes, 2000, 'Notes');
  const billing = b.billing === 'paid' ? 'paid' : b.billing === 'billable' ? 'billable' : client.billing_mode;
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).map(dateParam))].sort();
  if (!dates.length) bad('Pick at least one date.');
  if (dates.length > MAX_SCHEDULE) bad(`Schedule up to ${MAX_SCHEDULE} sessions at a time.`);

  // Booking someone for a client makes them that client's tutor, so they can
  // see the student and confirm the sessions.
  await env.DB.prepare('INSERT OR IGNORE INTO tutor_clients (tutor_email, client_id) VALUES (?, ?)').bind(tutor, clientId).run();
  const payRate = await defaultPayRate(env, tutor, clientId);
  const today = todayLocal();
  const ids = [];
  for (const date of dates) {
    // A day that's already over is booked as held: it happened.
    const status = date < today ? 'held' : 'scheduled';
    const row = await env.DB.prepare(`INSERT INTO sessions (tutor_email, client_id, date, start_time, minutes, service, notes,
        pay_rate, status, billing, scheduled_by, cal_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(tutor, clientId, date, start_time, minutes, service, notes, payRate, status, billing, user.email,
        status === 'scheduled' ? crypto.randomUUID() + '@palisadewriters.com' : null).first();
    ids.push({ id: row.id, date, status });
  }

  const invites = { sent: 0, failed: 0, errors: [], to: [] };
  if (b.send_invites !== false) {
    for (const { id, status } of ids) {
      if (status !== 'scheduled') continue;
      const r = await sendInvite(env, await sessionForInvite(env, id), 'request');
      invites.to = r.to;
      if (r.ok) invites.sent++; else { invites.failed++; if (!invites.errors.includes(r.error)) invites.errors.push(r.error); }
      await sleep(550); // stay under Resend's per-second limit
    }
  }
  const bal = await env.DB.prepare(`SELECT
      (SELECT COALESCE(SUM(sessions), 0) FROM packages WHERE client_id = ?1) -
      (SELECT COUNT(*) FROM sessions WHERE client_id = ?1 AND billing = 'paid' AND status != 'cancelled') AS left`).bind(clientId).first();
  return json({ created: ids.length, sessions: ids, invites, package_left: bal.left }, 201);
}

async function sessionForInvite(env, id) {
  return env.DB.prepare(`SELECT s.*, u.name AS tutor_name, c.name AS client_name, c.student, c.billing_email, c.student_email,
      c.location, c.is_test FROM sessions s JOIN users u ON u.email = s.tutor_email JOIN clients c ON c.id = s.client_id WHERE s.id = ?`).bind(id).first();
}

// kind 'request' sends (or updates) the invite; 'cancel' takes it off
// calendars. `only` limits it to some addresses (e.g. a tutor taken off it).
async function sendInvite(env, sess, kind, only) {
  if (!sess || !sess.cal_uid || !sess.start_time) return { ok: false, error: 'This session has no invite.', to: [] };
  const organizer = (env.CALENDAR_ORGANIZER || DEFAULT_ORGANIZER).toLowerCase();
  // The TEST client's parents and students are all the founders.
  const family = sess.is_test
    ? (await founderEmails(env)).map(email => ({ email, name: email }))
    : [{ email: sess.billing_email, name: sess.client_name }, { email: sess.student_email, name: sess.student }];
  const people = [
    ...family,
    { email: sess.tutor_email, name: sess.tutor_name },
  ].filter(p => p.email && p.email.toLowerCase() !== organizer && (!only || only.includes(p.email.toLowerCase())));
  const seen = new Set();
  const attendees = people.filter(p => !seen.has(p.email.toLowerCase()) && seen.add(p.email.toLowerCase()));
  if (!attendees.length) return { ok: false, error: 'Nobody to invite: add a billing or student email.', to: [] };

  const seq = (sess.cal_seq || 0) + (sess.invited_at ? 1 : 0);
  const method = kind === 'cancel' ? 'CANCEL' : 'REQUEST';
  const title = `Palisade Writers: ${sess.student || sess.client_name} with ${firstName(sess.tutor_name) || sess.tutor_email}`;
  const ics = buildIcs({ method, uid: sess.cal_uid, seq, title, date: sess.date, time: sess.start_time, minutes: sess.minutes,
    location: sess.location, description: [sess.service, sess.notes].filter(Boolean).join('\n\n'),
    organizer, attendees, cancelled: kind === 'cancel' });
  const when = `${longDate(sess.date)} at ${clock(sess.start_time)} (${duration(sess.minutes)})`;
  const html = kind === 'cancel'
    ? `<p>This Palisade Writers session has been cancelled:</p><p><strong>${esc(title)}</strong><br>${esc(when)}</p>`
    : `<p>You’re invited to a Palisade Writers session:</p><p><strong>${esc(title)}</strong><br>${esc(when)}${sess.location ? '<br>' + esc(sess.location) : ''}</p>
       <p>Use the invitation above (or the attached file) to add it to your calendar.</p>`;
  const r = await sendEmail(env, {
    from: `Palisade Writers <${organizer}>`,
    to: attendees.map(a => a.email),
    reply_to: organizer,
    subject: (kind === 'cancel' ? 'Cancelled: ' : sess.invited_at ? 'Updated: ' : 'Invitation: ') + title + ' — ' + shortDate(sess.date),
    html,
    attachments: [{ filename: kind === 'cancel' ? 'cancel.ics' : 'invite.ics', content: b64(ics),
      content_type: `text/calendar; charset=utf-8; method=${method}` }],
  });
  if (r.ok) {
    await env.DB.prepare("UPDATE sessions SET cal_seq = ?, invited_at = datetime('now') WHERE id = ?").bind(seq, sess.id).run();
  }
  return { ...r, to: attendees.map(a => a.email) };
}

function buildIcs({ method, uid, seq, title, date, time, minutes, location, description, organizer, attendees, cancelled }) {
  const end = addMinutes(date, time, minutes);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Palisade Writers//Portal//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VTIMEZONE', `TZID:${TZ}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:${uid}`, `SEQUENCE:${seq}`, `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${TZ}:${icsLocal(date, time)}`, `DTEND;TZID=${TZ}:${icsLocal(end.date, end.time)}`,
    `SUMMARY:${icsText(title)}`,
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    `ORGANIZER;CN=Palisade Writers:mailto:${organizer}`,
    ...attendees.map(a => `ATTENDEE;CN=${icsParam(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsParam = s => '"' + String(s || '').replace(/["\r\n]/g, '') + '"';
const icsLocal = (date, time) => date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
// Lines longer than 75 bytes continue on the next line after a space (RFC 5545).
function icsFold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000).toISOString();
  return { date: t.slice(0, 10), time: t.slice(11, 16) };
}
function b64(str) {
  let s = '';
  for (const byte of new TextEncoder().encode(str)) s += String.fromCharCode(byte);
  return btoa(s);
}
// Today's date in New York, where sessions happen.
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const longDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
function clock(t) { const [h, m] = t.split(':').map(Number); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm'); }
function duration(minutes) { const h = Math.floor(minutes / 60), m = minutes % 60; return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '') || '0m'; }
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- invoice email ----------

// Sends the invoice to the client's billing email, CC every founder. Never to
// a tutor. A draft becomes "sent".
async function emailInvoice(env, id) {
  const inv = await env.DB.prepare(`SELECT i.*, c.billing_email, c.is_test FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`).bind(id).first();
  if (!inv) throw new HttpError(404, 'Invoice not found.');
  if (inv.status === 'void') bad('This invoice was voided.');
  // The TEST client's parents are the founders.
  if (inv.is_test) inv.billing_email = (await founderEmails(env)).join(', ');
  if (!inv.billing_email) bad('This client has no billing email. Add one under Team & clients.');
  const { results: lines } = await env.DB.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort').bind(id).all();
  const tutors = new Set((await env.DB.prepare("SELECT email FROM users WHERE role = 'tutor'").all()).results.map(r => r.email));
  const to = inv.billing_email.split(', ');
  const cc = (await founderEmails(env)).filter(e => !to.includes(e) && !tutors.has(e));
  const r = await sendEmail(env, {
    from: env.EMAIL_FROM || 'Palisade Writers <billing@palisadewriters.com>',
    to,
    cc,
    reply_to: cc[0] || undefined,
    subject: (inv.is_test ? '[TEST] ' : '') + `Invoice ${inv.number} from ${inv.from_line} — ${monthName(inv.period)}`,
    html: invoiceEmailHtml(inv, lines),
  });
  if (!r.ok) throw new HttpError(502, r.error);
  const sentTo = [inv.billing_email, ...cc].join(', ');
  await env.DB.prepare(`UPDATE invoices SET emailed_at = datetime('now'), emailed_to = ?,
      status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END WHERE id = ?`).bind(sentTo, id).run();
  return json({ ok: true, to: inv.billing_email, cc });
}
const monthName = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }); };

function invoiceEmailHtml(inv, lines) {
  // Text edited on the invoice document (see invoiceDoc in invoice.html) replaces the defaults here too.
  let o = {};
  try { o = JSON.parse(inv.overrides || '{}'); } catch {}
  const t = (k, def) => esc(o[k] ?? def);
  const td = 'padding:6px 8px;border-bottom:1px dashed #d8d2c4;font-size:13px;';
  const rows = lines.map(l => `<tr>
    <td style="${td}white-space:nowrap">${l.date ? esc(shortDate(l.date)) : ''}</td>
    <td style="${td}">${esc(l.description)}</td>
    <td style="${td}text-align:right">${l.minutes ? esc(duration(l.minutes)) : ''}</td>
    <td style="${td}text-align:right">${l.rate !== null ? money(l.rate) : ''}</td>
    <td style="${td}text-align:right">${money(l.amount)}</td></tr>`).join('');
  const row = (k, v) => `<tr><td style="padding:3px 0;color:#6b6457;font-size:13px">${k}</td><td style="padding:3px 0;text-align:right;font-size:13px">${v}</td></tr>`;
  return `<div style="font-family:Georgia,serif;color:#1f1d1a;max-width:640px">
    <h2 style="margin:0 0 2px">${esc(inv.from_line)}</h2>
    <p style="margin:0 0 18px;font:600 12px Helvetica,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b6457">${t('t_head', 'Invoice')} ${esc(inv.number)}</p>
    <table style="width:100%;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif">
      ${row(t('l_billto', 'Bill to'), esc(inv.bill_to) + (inv.student ? ' (for ' + esc(inv.student) + ')' : ''))}
      ${row('Date', esc(longDate(inv.issued_date)))}
      ${row(t('l_period', 'Services for'), t('period_text', monthName(inv.period)))}
      ${row(t('l_due', 'Payment due'), esc(inv.due_text) || '—')}
      ${row(t('l_methods', 'Payment methods'), t('methods', 'Venmo or Zelle to @palisadewriters'))}
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-family:Helvetica,Arial,sans-serif">
      <tr><th align="left" style="${td}">${t('h_date', 'Date')}</th><th align="left" style="${td}">${t('h_desc', 'Description')}</th><th align="right" style="${td}">${t('h_len', 'Length')}</th><th align="right" style="${td}">${t('h_rate', 'Rate')}</th><th align="right" style="${td}">${t('h_amt', 'Amount')}</th></tr>
      ${rows}
    </table>
    <p style="font:700 15px Helvetica,Arial,sans-serif;text-align:right;border-top:1.5px solid #1f1d1a;padding-top:8px">${t('l_total', 'Total due')}: ${money(inv.total)}</p>
    ${inv.notes ? `<p style="font-size:14px;white-space:pre-wrap">${esc(inv.notes)}</p>` : ''}
    <p style="font:italic 12px Helvetica,Arial,sans-serif;color:#6b6457;line-height:1.55">${o.fee_text !== undefined ? esc(o.fee_text) : `Payment can be made via Venmo or Zelle to @palisadewriters. Credit card payments incur a
      2% fee that the payer is responsible for. Client is also responsible for any foreign transaction fees or bank/wire transfer
      fees incurred in sending payment. The amount received by ${esc(inv.from_line)} must equal the Total Due above, net of any such fees.`}</p>
    <p style="font:12px Helvetica,Arial,sans-serif;color:#6b6457">Questions about this invoice? Just reply to this email.</p>
  </div>`;
}

// ---------- validation helpers ----------

async function body(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) bad('Expected JSON.');
  try { return await request.json(); } catch { bad('Invalid JSON.'); }
}
function str(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') bad(`${field} is invalid.`);
  v = v.trim();
  if (v.length > max) bad(`${field} is too long.`);
  return v;
}
// A readable name for a pasted link when none is given.
function linkTitle(url) {
  if (/docs\.google\.com\/document/.test(url)) return 'Google Doc';
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'Google Sheet';
  if (/docs\.google\.com\/presentation/.test(url)) return 'Google Slides';
  if (/drive\.google\.com/.test(url)) return 'Google Drive';
  try { return new URL(url).hostname; } catch { return 'Link'; }
}

function emailParam(v, field) {
  const e = str(v, 200, field).toLowerCase();
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) bad(`${field} doesn’t look like an email address.`);
  return e;
}
function intParam(v, msg = 'Invalid id.') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(msg);
  return n;
}
function rateParam(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) bad('Rates must be between $0 and $10,000.');
  return round2(n);
}
function billedMinutes(v, what) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0 || n > 100 * 60) bad(`Enter a valid length for ${what}.`);
  return n;
}
function dateParam(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) bad('Enter a valid date.');
  return v;
}
function daysAgo(dateStr) {
  return (Date.now() - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
}
function monthParam(v) {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) bad('Enter a valid month.');
  return v;
}
function timeParam(v) {
  if (!v) return '';
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad('Enter a valid start time.');
  return v;
}
function minutesParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 720) bad('Length must be between 1 and 720 minutes.');
  return n;
}
const round2 = n => Math.round(n * 100) / 100;

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
