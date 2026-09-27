// Palisade Writers Worker.
// Static pages in public/ are served by Workers Assets; this script only
// handles /api/*, which backs the /timesheet (tutor) and /invoice (founder)
// portals. Auth is Google Sign-In -> verified here -> signed session cookie.
// Every permission check happens here, never in the browser.

const COOKIE = 'pw_session';
const SESSION_DAYS = 14;
const SERVICES = ['Tutoring session', 'Essay / async feedback', 'Consultation', 'Prep', 'Other'];

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
  const founders = (env.FOUNDER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!founders.length) { console.error('No FOUNDER_EMAILS configured; skipping monthly billing run.'); return; }
  const systemUser = { email: founders[0] };
  const period = previousMonth(new Date());
  const issued_date = new Date().toISOString().slice(0, 10);

  const invoices = await generateAllInvoices(env, systemUser, period, { issued_date, due_text: 'Within 7 days of this invoice', llc: false });
  const payroll = await computeMonthlyPayroll(env, period);

  if (!env.RESEND_API_KEY) { console.error('No RESEND_API_KEY configured; skipping monthly billing email.'); return; }
  await sendMonthlyEmail(env, founders, period, invoices, payroll);
}

function previousMonth(d) {
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return prev.toISOString().slice(0, 7);
}

async function sendMonthlyEmail(env, founders, period, invoices, payroll) {
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
    <h3>Invoices to send (${invoices.created.length})</h3>
    ${table(invoices.created, 'Client')}
    ${skippedList(invoices.skipped)}
    <h3>Payroll owed</h3>
    ${payrollTable}
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Palisade Writers <billing@palisadewriters.com>',
      to: founders,
      subject: `Palisade Writers — ${period} invoices & payroll summary`,
      html,
    }),
  });
  if (!res.ok) console.error('Resend email failed:', res.status, await res.text());
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
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', services: SERVICES, devLogin: env.DEV_MODE === '1' });
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
      ? await env.DB.prepare('SELECT id, name, student FROM clients WHERE active = 1 ORDER BY name').all()
      : await env.DB.prepare(`SELECT c.id, c.name, c.student FROM tutor_clients tc JOIN clients c ON c.id = tc.client_id
          WHERE tc.tutor_email = ? AND c.active = 1 ORDER BY c.name`).bind(user.email).all();
    return json(results);
  }

  if (seg[0] !== 'sessions') throw new HttpError(404, 'Not found.');

  if (seg.length === 1 && method === 'GET') {
    const month = monthParam(url.searchParams.get('month'));
    // Deliberately no client billing rates here.
    const { results } = await env.DB.prepare(`SELECT s.id, s.client_id, c.name AS client_name, c.student, s.date, s.start_time,
        s.minutes, s.service, s.notes, s.pay_rate, (s.invoice_id IS NOT NULL) AS locked
        FROM sessions s JOIN clients c ON c.id = s.client_id
        WHERE s.tutor_email = ? AND substr(s.date, 1, 7) = ? ORDER BY s.date, s.start_time, s.id`)
      .bind(user.email, month).all();
    return json(results);
  }

  if (seg.length === 1 && method === 'POST') {
    const s = sessionFields(await body(request));
    await assertCanUseClient(env, user, s.client_id);
    const payRate = await defaultPayRate(env, user.email, s.client_id);
    const row = await env.DB.prepare(`INSERT INTO sessions (tutor_email, client_id, date, start_time, minutes, service, notes, pay_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(user.email, s.client_id, s.date, s.start_time, s.minutes, s.service, s.notes, payRate).first();
    return json({ id: row.id }, 201);
  }

  if (seg.length === 2 && (method === 'PUT' || method === 'DELETE')) {
    const id = intParam(seg[1]);
    const existing = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND tutor_email = ?').bind(id, user.email).first();
    if (!existing) throw new HttpError(404, 'Session not found.');
    if (existing.invoice_id) throw new HttpError(409, 'This session has already been invoiced. Ask a founder to change it.');
    if (daysAgo(existing.date) > 31) throw new HttpError(409, "Sessions more than 31 days old can't be changed. Ask a founder to fix it.");

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    const s = sessionFields(await body(request));
    let payRate = existing.pay_rate;
    if (s.client_id !== existing.client_id) {
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
      const [{ results: clients }, { results: links }] = await env.DB.batch([
        env.DB.prepare(`SELECT c.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.client_id = c.id) AS session_count,
            (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id) AS invoice_count
          FROM clients c ORDER BY c.active DESC, c.name`),
        env.DB.prepare('SELECT tutor_email, client_id, pay_rate, client_rate FROM tutor_clients'),
      ]);
      for (const c of clients) c.tutors = links.filter(l => l.client_id === c.id);
      return json(clients);
    }
    if (method === 'POST' || method === 'PUT') {
      const b = await body(request);
      const name = str(b.name, 120, 'Client name');
      if (!name) bad('Client name is required.');
      const defaultRate = rateParam(b.default_rate);
      if (defaultRate === null) bad('Set a default rate for this client.');
      const vals = [name, str(b.student, 120, 'Student'), str(b.billing_email, 200, 'Billing email'),
        str(b.location, 200, 'Location'), defaultRate, str(b.notes, 1000, 'Notes')];
      if (method === 'POST' && !id) {
        const row = await env.DB.prepare(`INSERT INTO clients (name, student, billing_email, location, default_rate, notes)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).bind(...vals).first();
        return json({ id: row.id }, 201);
      }
      if (method === 'PUT' && id) {
        const r = await env.DB.prepare(`UPDATE clients SET name = ?, student = ?, billing_email = ?, location = ?, default_rate = ?, notes = ?,
            active = ? WHERE id = ?`).bind(...vals, b.active ? 1 : 0, intParam(id)).run();
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
      const [sess, , del] = await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM tutor_clients WHERE client_id = ?').bind(clientId),
        env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(clientId),
      ]);
      if (!del.meta.changes) throw new HttpError(404, 'Client not found.');
      return json({ ok: true, sessions_deleted: sess.meta.changes });
    }
  }

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
      if (q.get('status') === 'uninvoiced') where.push('s.invoice_id IS NULL');
      if (q.get('status') === 'invoiced') where.push('s.invoice_id IS NOT NULL');
      const { results } = await env.DB.prepare(`SELECT s.*, u.name AS tutor_name, c.name AS client_name, c.student,
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
      const s = sessionFields(b);
      await env.DB.prepare(`UPDATE sessions SET client_id = ?, date = ?, start_time = ?, minutes = ?, service = ?, notes = ?,
          pay_rate = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(s.client_id, s.date, s.start_time, s.minutes, s.service, s.notes, rateParam(b.pay_rate), sid).run();
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND invoice_id IS NULL').bind(intParam(id)).run();
      if (!r.meta.changes) throw new HttpError(409, 'Void the invoice first, or the session no longer exists.');
      return json({ ok: true });
    }
  }

  // Invoices
  if (resource === 'invoices') {
    if (!id && method === 'GET') {
      const month = q.get('month') ? monthParam(q.get('month')) : null;
      const { results } = await env.DB.prepare(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id
          ${month ? 'WHERE i.period = ?' : ''} ORDER BY i.created_at DESC`).bind(...(month ? [month] : [])).all();
      return json(results);
    }
    if (id && method === 'GET') {
      const inv = await env.DB.prepare(`SELECT i.*, c.billing_email FROM invoices i JOIN clients c ON c.id = i.client_id
          WHERE i.id = ?`).bind(id).first();
      if (!inv) throw new HttpError(404, 'Invoice not found.');
      const { results } = await env.DB.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort').bind(id).all();
      inv.lines = results;
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

  throw new HttpError(404, 'Not found.');
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
    const rate = rateParam(l.rate);
    if (rate === null) bad(`Set a rate for the ${s.date} session.`);
    // Billed length can differ from the logged length (e.g. rounding up); the
    // session's own minutes, which drive tutor pay, are left untouched.
    const minutes = l.minutes === undefined || l.minutes === null ? s.minutes : billedMinutes(l.minutes, `the ${s.date} session`);
    lines.push({
      session_id: s.id, date: s.date, minutes, rate,
      description: str(l.description, 200, 'Description') || s.service || 'Tutoring session',
      amount: round2(rate * minutes / 60),
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
    if (minutes && rate !== null) amount = round2(rate * minutes / 60);
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
  const saved = await saveInvoice(env, user, client, period, issued, str(b.due_text, 120, 'Payment due'), !!b.llc, str(b.notes, 1000, 'Notes'), lines);
  return json(saved, 201);
}

async function nextNumber(env, table, prefix) {
  const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE number LIKE ?`).bind(prefix + '%').first();
  return prefix + String(n + 1).padStart(2, '0');
}

// Shared by the manual builder and "Generate all invoices". One batch = one
// transaction: the invoice, its lines and the session links land together or not at all.
async function saveInvoice(env, user, client, period, issued, dueText, llc, notes, lines) {
  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const number = await nextNumber(env, 'invoices', 'PW-' + period.replace('-', '') + '-');
  const invoiceId = crypto.randomUUID();
  const stmts = [
    env.DB.prepare(`INSERT INTO invoices (id, number, client_id, period, issued_date, due_text, bill_to, student, from_line, notes, total, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(invoiceId, number, client.id, period, issued, dueText, client.name, client.student,
        llc ? 'Palisade Writers LLC' : 'Palisade Writers', notes, total, user.email),
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
    created.push({ client_id: client.id, name: client.name, number: saved.number, total: saved.total });
  }
  return { created, skipped };
}

// Read-only, unlocked snapshot of pay owed per tutor for `period` — for the monthly
// email only. Pay stubs themselves are generated on demand from live data (see
// invoice.html), never persisted, so there's nothing to "generate" here to save.
async function computeMonthlyPayroll(env, period) {
  const { results: sessions } = await env.DB.prepare(`SELECT s.tutor_email, s.pay_rate, s.minutes, u.name AS tutor_name
      FROM sessions s JOIN users u ON u.email = s.tutor_email WHERE substr(s.date, 1, 7) = ?`).bind(period).all();
  const byTutor = new Map();
  for (const s of sessions) {
    const t = byTutor.get(s.tutor_email) || { name: s.tutor_name || s.tutor_email, pay: 0, missing: 0 };
    if (s.pay_rate === null) t.missing++; else t.pay += round2(s.pay_rate * s.minutes / 60);
    byTutor.set(s.tutor_email, t);
  }
  return [...byTutor.values()];
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
