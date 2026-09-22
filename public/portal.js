// Shared helpers for /timesheet and /invoice: API calls, Google sign-in, formatting.
// The server enforces every permission; nothing here is a security boundary.
(function(){
  const $ = id => document.getElementById(id);

  async function api(path, opts = {}){
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if(!res.ok){
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Resolves with the signed-in user once they're in. Shows the sign-in gate until then.
  async function requireUser(){
    const config = await api('config');
    try {
      const me = await api('me');
      return { me, config };
    } catch(err){
      if(err.status !== 401) throw err;
    }
    $('gate').hidden = false;
    if(config.devLogin){
      // Local `wrangler dev` only (DEV_MODE in .dev.vars); the deployed site never offers this.
      return new Promise(resolve => {
        $('gsiButton').innerHTML = '<form class="row" id="devForm"><input type="email" id="devEmail" placeholder="dev: sign in as email" required><button class="btn btn-primary">Go</button></form>';
        $('devForm').addEventListener('submit', async e => {
          e.preventDefault();
          try {
            await api('dev-login', { method: 'POST', body: { email: $('devEmail').value } });
            $('gate').hidden = true;
            resolve({ me: await api('me'), config });
          } catch(err){ $('gateMsg').textContent = err.message; }
        });
      });
    }
    if(!config.googleClientId){
      $('gateMsg').textContent = 'Google sign-in has not been set up yet.';
      return new Promise(() => {});
    }
    await loadScript('https://accounts.google.com/gsi/client');
    return new Promise(resolve => {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async resp => {
          $('gateMsg').textContent = '';
          try {
            await api('login', { method: 'POST', body: { credential: resp.credential } });
            const me = await api('me');
            $('gate').hidden = true;
            resolve({ me, config });
          } catch(err){
            $('gateMsg').textContent = err.message;
          }
        },
      });
      google.accounts.id.renderButton($('gsiButton'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
    });
  }

  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(s);
    });
  }

  async function signOut(){
    await api('logout', { method: 'POST', body: {} });
    if(window.google && google.accounts) google.accounts.id.disableAutoSelect();
    location.reload();
  }

  function esc(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function money(n){
    if(n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const round2 = n => Math.round(n * 100) / 100;
  function hours(minutes){
    const h = minutes / 60;
    return (Math.round(h * 100) / 100).toLocaleString('en-US') + ' h';
  }
  function duration(minutes){
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '') || '0m';
  }
  function fmtDate(iso, opts){
    if(!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', weekday: 'short' });
  }
  function fmtTime(t){
    if(!t) return '';
    const [h, m] = t.split(':').map(Number);
    return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
  }
  function monthLabel(ym){
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function localISO(d = new Date()){
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const thisMonth = () => localISO().slice(0, 7);
  function shiftMonth(ym, delta){
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  let toastTimer;
  function toast(msg, isErr){
    let el = document.querySelector('.toast');
    if(!el){ el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 2500);
  }

  window.Portal = { $, api, requireUser, signOut, esc, money, round2, hours, duration, fmtDate, fmtTime, monthLabel, localISO, thisMonth, shiftMonth, toast };
})();
