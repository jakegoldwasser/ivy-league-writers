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
};

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

async function sessionCookie(env, email) {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(payload));
  return `${COOKIE}=${payload}.${b64urlEncode(new Uint8Array(sig))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function currentUser(request, env) {
  const cookies = Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const raw = cookies[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlDecode(sig), new TextEncoder().encode(payload));
  } catch { return null; }
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  if (!(data.x > Date.now())) return null;
  // Re-checked on every request, so deactivating someone takes effect immediately.
  return loadUser(env, data.e);
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
      const { results } = await env.DB.prepare('SELECT email, name, role, default_pay_rate, active FROM users ORDER BY role, name, email').all();
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
  }

  // Clients (with their tutor assignments)
  if (resource === 'clients') {
    if (!id && method === 'GET') {
      const [{ results: clients }, { results: links }] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM clients ORDER BY active DESC, name'),
        env.DB.prepare('SELECT tutor_email, client_id, pay_rate, client_rate FROM tutor_clients'),
      ]);
      for (const c of clients) c.tutors = links.filter(l => l.client_id === c.id);
      return json(clients);
    }
    if (method === 'POST' || method === 'PUT') {
      const b = await body(request);
      const name = str(b.name, 120, 'Client name');
      if (!name) bad('Client name is required.');
      const vals = [name, str(b.student, 120, 'Student'), str(b.billing_email, 200, 'Billing email'),
        rateParam(b.default_rate), str(b.notes, 1000, 'Notes')];
      if (method === 'POST' && !id) {
        const row = await env.DB.prepare(`INSERT INTO clients (name, student, billing_email, default_rate, notes)
            VALUES (?, ?, ?, ?, ?) RETURNING id`).bind(...vals).first();
        return json({ id: row.id }, 201);
      }
      if (method === 'PUT' && id) {
        const r = await env.DB.prepare(`UPDATE clients SET name = ?, student = ?, billing_email = ?, default_rate = ?, notes = ?,
            active = ? WHERE id = ?`).bind(...vals, b.active ? 1 : 0, intParam(id)).run();
        if (!r.meta.changes) throw new HttpError(404, 'Client not found.');
        return json({ ok: true });
      }
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
  if (reqLines.length > 200 || extras.length > 20) bad('Too many lines.');

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
    lines.push({
      session_id: s.id, date: s.date, minutes: s.minutes, rate,
      description: str(l.description, 200, 'Description') || s.service || 'Tutoring session',
      amount: round2(rate * s.minutes / 60),
    });
  }
  lines.sort((a, b2) => a.date.localeCompare(b2.date));
  for (const e of extras) {
    const description = str(e.description, 200, 'Line item');
    const amount = Number(e.amount);
    if (!description || !Number.isFinite(amount) || Math.abs(amount) > 100000) bad('Each extra line needs a description and amount.');
    lines.push({ session_id: null, date: '', minutes: null, rate: null, description, amount: round2(amount) });
  }
  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));

  const prefix = 'PW-' + period.replace('-', '') + '-';
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?').bind(prefix + '%').first();
  const number = prefix + String(n + 1).padStart(2, '0');
  const invoiceId = crypto.randomUUID();

  // One batch = one transaction: the invoice, its lines and the session links land together or not at all.
  const stmts = [
    env.DB.prepare(`INSERT INTO invoices (id, number, client_id, period, issued_date, due_text, bill_to, student, from_line, notes, total, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(invoiceId, number, clientId, period, issued, str(b.due_text, 120, 'Payment due'), client.name, client.student,
        b.llc ? 'Palisade Writers LLC' : 'Palisade Writers', str(b.notes, 1000, 'Notes'), total, user.email),
    ...lines.map((l, i) => env.DB.prepare(`INSERT INTO invoice_lines (invoice_id, session_id, date, description, minutes, rate, amount, sort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(invoiceId, l.session_id, l.date, l.description, l.minutes, l.rate, l.amount, i)),
    ...lines.filter(l => l.session_id).map(l => env.DB.prepare(
      'UPDATE sessions SET invoice_id = ?, client_rate = ? WHERE id = ? AND invoice_id IS NULL').bind(invoiceId, l.rate, l.session_id)),
  ];
  await env.DB.batch(stmts);
  return json({ id: invoiceId, number }, 201);
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
function dateParam(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) bad('Enter a valid date.');
  return v;
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
