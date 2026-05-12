/**
 * Phoenix Method — Unified Client Portal
 *
 * One worker, many clients. Allowlist (KV) maps email -> { client, name }.
 * Each client's portal content lives under public/{client-slug}/.
 * After sign-in, a user can only access their own slug; attempts to reach
 * other slugs return 404.
 *
 * Routes:
 *   GET  /                       — login page if no session, otherwise redirect to /{client}/
 *   POST /auth/request           — { email }; sends magic link if email is on the allowlist (always 200)
 *   GET  /auth/verify?t=         — validates token, sets session cookie, redirects to /{client}/
 *   GET  /auth/logout            — clears cookie, back to login page
 *   GET  /{client}/*             — serves static assets if session.client matches {client}
 */

const COOKIE_NAME = 'phoenix_session';
const MAGIC_TTL_SECONDS = 15 * 60;
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW = 600;
const TEXT_ENCODER = new TextEncoder();

// ──────────────────────────────────────────────────────────────
// Crypto

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', TEXT_ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function b64urlEncode(bytes) {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
async function signToken(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}
async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const sigBytes = Uint8Array.from(b64urlDecode(sig), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, TEXT_ENCODER.encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────
// Helpers

function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validSlug(slug) { return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug); }
function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}
async function currentSession(request, env) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return null;
  const payload = await verifyToken(cookie, env.SESSION_SECRET);
  return payload && payload.kind === 'session' ? payload : null;
}
async function rateLimitOk(env, ip) {
  const key = `rl:${ip}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_MAX) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}
async function lookupAllowlist(env, email) {
  const raw = await env.ALLOWLIST.get(email);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (obj.isAdmin) return { client: obj.client || 'lori', name: obj.name || '', isAdmin: true };
      if (validSlug(obj.client)) return { client: obj.client, name: obj.name || '' };
    }
  } catch { /* fall through */ }
  return null;
}

// ──────────────────────────────────────────────────────────────
// Pages

function page(title, bodyInner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Rajdhani:wght@500;700&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#07070D; --card:#131320; --border:rgba(255,255,255,0.08); --text:#F0EDE6; --muted:#A8A49C; --deep-muted:#6B6860; --fire-start:#FF4D00; --fire-mid:#FF8C00; --fire-end:#FFB800; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Outfit',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px 20px; line-height:1.6; }
  .card { max-width:480px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:20px; padding:44px 36px; text-align:center; }
  .logo { display:block; margin:0 auto 24px; max-width:260px; width:80%; height:auto; }
  .tag { font-family:'Rajdhani',sans-serif; font-weight:700; font-size:0.72rem; letter-spacing:0.25em; text-transform:uppercase; color:var(--fire-mid); margin-bottom:18px; }
  h1 { font-family:'Cinzel',serif; font-weight:900; font-size:clamp(1.6rem,4.5vw,2.2rem); line-height:1.2; margin-bottom:14px; }
  .fire { background:linear-gradient(135deg,var(--fire-start),var(--fire-mid),var(--fire-end)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
  .lede { color:var(--muted); font-size:0.98rem; margin-bottom:26px; }
  form { display:flex; flex-direction:column; gap:12px; }
  label { font-family:'Rajdhani',sans-serif; font-size:0.78rem; letter-spacing:0.12em; text-transform:uppercase; color:var(--muted); text-align:left; font-weight:500; }
  input[type=email] { width:100%; padding:14px 16px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-family:'Outfit',sans-serif; font-size:1rem; transition:border-color .2s; }
  input[type=email]:focus { outline:none; border-color:var(--fire-mid); }
  button { padding:14px 28px; border:none; border-radius:8px; background:linear-gradient(135deg,var(--fire-start),var(--fire-mid)); color:#fff; font-family:'Rajdhani',sans-serif; font-weight:700; font-size:0.95rem; letter-spacing:0.12em; text-transform:uppercase; cursor:pointer; transition:transform .15s,box-shadow .2s,opacity .2s; }
  button:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(255,140,0,0.25); }
  button:disabled { opacity:0.55; cursor:not-allowed; }
  .status { margin-top:18px; padding:14px 18px; border-radius:8px; font-size:0.9rem; text-align:left; display:none; }
  .status.show { display:block; }
  .status.success { background:rgba(255,184,0,0.08); border:1px solid rgba(255,184,0,0.3); }
  .status.error { background:rgba(255,77,77,0.1); border:1px solid rgba(255,77,77,0.3); }
  .fallback { margin-top:22px; font-size:0.82rem; color:var(--deep-muted); }
  .fallback a { color:var(--muted); text-decoration:none; }
  .fallback a:hover { color:var(--fire-mid); }
  .footer-note { margin-top:26px; padding-top:18px; border-top:1px solid var(--border); font-family:'Rajdhani',sans-serif; font-size:0.72rem; letter-spacing:0.15em; text-transform:uppercase; color:var(--deep-muted); }
</style>
</head>
<body>
  <div class="card">
    <img src="https://phoenixmethodseo.com/assets/phoenix-full-logo.png" alt="Phoenix Method" class="logo">
    ${bodyInner}
    <div class="footer-note">Phoenix Method &bull; Client Portal</div>
  </div>
</body>
</html>`;
}

function loginHTML() {
  const body = `
    <div class="tag">Client Portal</div>
    <h1>Sign in to your <span class="fire">portal</span></h1>
    <p class="lede">Enter your email and we'll send you a secure sign-in link. No passwords.</p>
    <form id="loginForm" novalidate>
      <label for="email">Your email</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@yourbusiness.com">
      <button type="submit" id="submitBtn">Send me my link</button>
    </form>
    <div class="status" id="status"></div>
    <p class="fallback">Don't have access? <a href="mailto:hello@phoenixmethodseo.com">Contact Phoenix Method</a></p>
    <script>
      (function () {
        var form=document.getElementById('loginForm'),btn=document.getElementById('submitBtn'),input=document.getElementById('email'),status=document.getElementById('status');
        function show(m,t){status.textContent=m;status.className='status show '+t;}
        form.addEventListener('submit',function(e){
          e.preventDefault();
          var email=(input.value||'').trim().toLowerCase();
          if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){show('Enter a valid email address.','error');return;}
          btn.disabled=true;btn.textContent='Sending…';
          fetch('/auth/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})})
            .then(function(r){return r.ok?r.json():Promise.reject(r);})
            .then(function(){show("If that email is registered, you'll get a sign-in link shortly. Check your inbox (and spam).",'success');form.reset();})
            .catch(function(){show('Something went wrong. Please try again, or email hello@phoenixmethodseo.com.','error');})
            .finally(function(){btn.disabled=false;btn.textContent='Send me my link';});
        });
      })();
    </script>
  `;
  return page('Sign in to your Phoenix Method portal', body);
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function adminDashboardHTML(env) {
  // List all client slugs from the PORTAL_DATA KV namespace
  const list = env.PORTAL_DATA ? await env.PORTAL_DATA.list() : { keys: [] };
  const slugs = list.keys.map((k) => k.name).filter((n) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(n)).sort();

  // Fetch each client's data.json from KV in parallel
  const clients = await Promise.all(slugs.map(async (slug) => {
    try {
      const raw = await env.PORTAL_DATA.get(slug, { type: 'text' });
      if (!raw) return { slug, error: 'no data in KV' };
      const data = JSON.parse(raw);
      const lastMsg = (data.messages && data.messages[0]) || null;
      const completedDeliv = (data.deliverables || []).filter((d) => d.status === 'completed').length;
      const totalDeliv = (data.deliverables || []).length;
      return {
        slug,
        client: data.client || slug,
        short_name: data.short_name || data.client || slug,
        month: data.month || '',
        plan: data.plan || '',
        plan_price: data.plan_price || '',
        plan_hours: data.plan_hours,
        hours_used: data.hours_used,
        hours_rolled_over: data.hours_rolled_over || 0,
        updated: data.updated || '',
        deliv_progress: `${completedDeliv}/${totalDeliv}`,
        last_msg_date: lastMsg ? (lastMsg.date || '') : '',
        last_msg_text: lastMsg ? (lastMsg.text || '').slice(0, 140) : '',
        next_invoice_date: (data.next_invoice && data.next_invoice.date) || '',
        next_invoice_amount: (data.next_invoice && data.next_invoice.amount) || '',
      };
    } catch (e) {
      return { slug, error: 'parse error: ' + e.message };
    }
  }));

  // Sort by updated date desc (most recent first)
  clients.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

  const rows = clients.map((c) => {
    if (c.error) {
      return `<div class="row error-row">
        <div class="row-main"><strong>${escapeHTML(c.slug)}</strong> &mdash; <span class="muted">${escapeHTML(c.error)}</span></div>
      </div>`;
    }
    const hoursStr = (c.hours_used != null && c.plan_hours != null)
      ? `${c.hours_used}/${c.plan_hours}${c.hours_rolled_over ? ` (+${c.hours_rolled_over} rollover)` : ''}`
      : '—';
    const hoursDone = c.hours_used >= c.plan_hours;
    return `<div class="row">
      <div class="row-head">
        <div>
          <div class="client-name">${escapeHTML(c.client)}</div>
          <div class="client-meta">/${escapeHTML(c.slug)}/ &middot; ${escapeHTML(c.plan)} ${escapeHTML(c.plan_price)} &middot; ${escapeHTML(c.month)}</div>
        </div>
        <a class="open-btn" href="/${escapeHTML(c.slug)}/" target="_blank" rel="noopener">Open portal &rarr;</a>
      </div>
      <div class="row-stats">
        <div class="stat"><div class="stat-label">Hours</div><div class="stat-val ${hoursDone ? 'done' : ''}">${escapeHTML(hoursStr)}</div></div>
        <div class="stat"><div class="stat-label">Deliverables</div><div class="stat-val">${escapeHTML(c.deliv_progress)}</div></div>
        <div class="stat"><div class="stat-label">Updated</div><div class="stat-val">${escapeHTML(c.updated || '—')}</div></div>
        <div class="stat"><div class="stat-label">Next invoice</div><div class="stat-val">${escapeHTML(c.next_invoice_date || '—')} ${escapeHTML(c.next_invoice_amount || '')}</div></div>
      </div>
      ${c.last_msg_date ? `<div class="last-msg"><span class="muted">Last update ${escapeHTML(c.last_msg_date)}:</span> ${escapeHTML(c.last_msg_text)}${c.last_msg_text && c.last_msg_text.length >= 140 ? '…' : ''}</div>` : ''}
    </div>`;
  }).join('');

  const body = `
    <div class="tag">Admin</div>
    <h1><span class="fire">All Client Portals</span></h1>
    <p class="lede">${clients.length} client${clients.length === 1 ? '' : 's'} &middot; sorted by most recently updated</p>
    <div class="rows">
      ${rows || '<p class="muted">No clients found in PORTAL_DATA KV.</p>'}
    </div>
    <p class="fallback"><a href="/auth/logout">Sign out</a></p>
  `;
  // Override the default narrow .card width and add admin-specific styles
  return page('Admin — All Portals', body).replace(
    '.card { max-width:480px;',
    '.card { max-width:920px; text-align:left; }\n  .card.admin-narrow { max-width:480px;'
  ).replace(
    '</style>',
    `
  .rows { display:flex; flex-direction:column; gap:14px; margin-top:18px; }
  .row { background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:12px; padding:18px 20px; }
  .row-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
  .client-name { font-family:'Cinzel',serif; font-size:1.15rem; font-weight:700; color:var(--text); }
  .client-meta { font-family:'Rajdhani',sans-serif; font-size:0.78rem; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin-top:4px; }
  .open-btn { background:linear-gradient(135deg,var(--fire-start),var(--fire-mid)); color:#fff; padding:8px 16px; border-radius:6px; text-decoration:none; font-family:'Rajdhani',sans-serif; font-weight:700; font-size:0.78rem; letter-spacing:0.1em; text-transform:uppercase; white-space:nowrap; }
  .open-btn:hover { box-shadow:0 6px 18px rgba(255,140,0,0.3); }
  .row-stats { display:flex; gap:24px; flex-wrap:wrap; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .stat { min-width:90px; }
  .stat-label { font-family:'Rajdhani',sans-serif; font-size:0.7rem; letter-spacing:0.12em; text-transform:uppercase; color:var(--deep-muted); }
  .stat-val { font-size:0.95rem; color:var(--text); margin-top:2px; }
  .stat-val.done { color:var(--fire-mid); font-weight:600; }
  .last-msg { margin-top:12px; padding-top:12px; border-top:1px solid var(--border); font-size:0.88rem; color:var(--text); line-height:1.5; }
  .muted { color:var(--muted); }
  .error-row { border-color: rgba(255,77,77,0.4); background:rgba(255,77,77,0.05); }
</style>`
  );
}

function verifyErrorHTML(msg) {
  const body = `
    <div class="tag">Sign-in error</div>
    <h1>Link is <span class="fire">not valid</span></h1>
    <p class="lede">${msg}</p>
    <form action="/" method="get"><button type="submit">Back to sign-in</button></form>
  `;
  return page('Sign-in error — Phoenix Method', body);
}

// ──────────────────────────────────────────────────────────────
// Email

function emailTemplate({ magicUrl, clientName }) {
  const subject = `Your Phoenix Method portal sign-in link`;
  const text = `Click this link to sign in to your Phoenix Method client portal:

${magicUrl}

This link is valid for 15 minutes. After you sign in, your browser will remember you for 7 days.

If you didn't request this, you can safely ignore it.

— Phoenix Method
hello@phoenixmethodseo.com`;

  const greet = clientName ? `Hi ${clientName},<br><br>` : '';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#07070D;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#131320;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
      <tr><td style="padding:32px 36px 8px;background:linear-gradient(135deg,#FF4D00,#FF8C00,#FFB800);">
        <div style="font-family:'Cinzel',serif;font-size:22px;font-weight:900;color:#fff;letter-spacing:0.04em;">PHOENIX METHOD</div>
      </td></tr>
      <tr><td style="padding:36px;color:#F0EDE6;">
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#F0EDE6;">Your sign-in link</h1>
        <p style="margin:0 0 24px;color:#A8A49C;font-size:15px;line-height:1.6;">${greet}Click below to sign in to your client portal. This link is valid for 15 minutes.</p>
        <p style="margin:0 0 28px;"><a href="${magicUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#FF4D00,#FF8C00);color:#fff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;">Sign in to Portal &rarr;</a></p>
        <p style="margin:0 0 8px;color:#6B6860;font-size:13px;line-height:1.6;">Or paste this URL in your browser:</p>
        <p style="margin:0 0 24px;color:#A8A49C;font-size:13px;word-break:break-all;">${magicUrl}</p>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">
        <p style="margin:0;color:#6B6860;font-size:12px;line-height:1.6;">If you didn't request this, ignore it — your account stays safe.</p>
      </td></tr>
      <tr><td style="padding:20px 36px;background:#0E0E18;color:#6B6860;font-size:12px;text-align:center;">
        Phoenix Method &bull; <a href="mailto:hello@phoenixmethodseo.com" style="color:#FF8C00;text-decoration:none;">hello@phoenixmethodseo.com</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, text, html };
}

async function sendViaResend({ env, to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// ──────────────────────────────────────────────────────────────
// Router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/auth/request' && request.method === 'POST') return handleAuthRequest(request, env, url);
    if (path === '/auth/verify') return handleAuthVerify(request, env, url);
    if (path === '/auth/admin-bookmark') return handleAdminBookmark(request, env, url);
    if (path === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    const session = await currentSession(request, env);

    // Root: login page if not authed, redirect to their client area (or /admin/ if admin)
    if (path === '/' || path === '') {
      if (session) {
        const dest = session.isAdmin ? '/admin/' : `/${session.client}/`;
        return Response.redirect(`${url.origin}${dest}`, 302);
      }
      return new Response(loginHTML(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // Admin dashboard — lists all clients (admin-only)
    if (path === '/admin' || path === '/admin/') {
      if (!session) {
        return new Response(loginHTML(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (!session.isAdmin) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(await adminDashboardHTML(env), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // Any other path requires a session
    if (!session) {
      const accept = request.headers.get('Accept') || '';
      if (request.method === 'GET' && accept.includes('text/html')) {
        return new Response(loginHTML(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      return new Response('Unauthorized', { status: 401 });
    }

    // Enforce: user can only access /{their-client}/* — no cross-client peeking (admin exempt)
    const segments = path.split('/').filter(Boolean);
    const requestedClient = segments[0];
    if (requestedClient !== session.client && !session.isAdmin) {
      return new Response('Not Found', { status: 404 });
    }

    // Serve data.json from KV so the weekly health check can update stats without a redeploy
    const rest = segments.slice(1).join('/');
    if (rest === 'data.json' && env.PORTAL_DATA) {
      const data = await env.PORTAL_DATA.get(requestedClient, { type: 'text' });
      if (data) {
        return new Response(data, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    }

    // All good — hand off to static assets
    return env.ASSETS.fetch(request);
  },
};

// ──────────────────────────────────────────────────────────────
// Handlers

async function handleAuthRequest(request, env, url) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await rateLimitOk(env, ip))) return Response.json({ ok: true });

  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const email = (body.email || '').toString().trim().toLowerCase();
  if (!validEmail(email)) return new Response('Bad email', { status: 400 });

  const entry = await lookupAllowlist(env, email);
  if (!entry) return Response.json({ ok: true });

  const exp = Math.floor(Date.now() / 1000) + MAGIC_TTL_SECONDS;
  const token = await signToken({ kind: 'magic', email, client: entry.client, isAdmin: entry.isAdmin || false, exp }, env.SESSION_SECRET);
  const magicUrl = `${url.origin}/auth/verify?t=${encodeURIComponent(token)}`;

  try {
    const { subject, text, html } = emailTemplate({ magicUrl, clientName: entry.name });
    await sendViaResend({ env, to: email, subject, text, html });
  } catch (err) {
    console.error('resend send failed', err);
  }
  return Response.json({ ok: true });
}

async function handleAdminBookmark(request, env, url) {
  // Permanent admin session via bookmarkable URL: /auth/admin-bookmark?k=SECRET
  // Sets a 10-year admin session cookie. Anyone with the URL gets admin access — keep it private.
  const k = url.searchParams.get('k');
  if (!env.ADMIN_BYPASS_KEY || !k || k !== env.ADMIN_BYPASS_KEY) {
    return new Response('Not Found', { status: 404 });
  }
  // 10-year session cookie
  const sessionDays = 3650;
  const sessionExp = Math.floor(Date.now() / 1000) + sessionDays * 86400;
  const sessionToken = await signToken(
    { kind: 'session', email: 'admin@phoenixmethodseo.com', client: 'lori', isAdmin: true, exp: sessionExp },
    env.SESSION_SECRET
  );
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin/',
      'Set-Cookie': `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDays * 86400}`,
    },
  });
}

async function handleAuthVerify(request, env, url) {
  const token = url.searchParams.get('t');
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload || payload.kind !== 'magic' || !validSlug(payload.client)) {
    return new Response(verifyErrorHTML('This link is expired or invalid. Request a new one below.'), {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const sessionDays = parseInt(env.SESSION_DAYS || '7', 10);
  const sessionExp = Math.floor(Date.now() / 1000) + sessionDays * 86400;
  const sessionToken = await signToken({ kind: 'session', email: payload.email, client: payload.client, isAdmin: payload.isAdmin || false, exp: sessionExp }, env.SESSION_SECRET);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': `/${payload.client}/`,
      'Set-Cookie': `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDays * 86400}`,
    },
  });
}
