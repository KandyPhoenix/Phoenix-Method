/**
 * Phoenix Method — Portal Magic Link Worker
 *
 * POST /request  { email: "client@domain.com" }
 *   - If email is on the allowlist, emails the client their portal URL.
 *   - Always returns 200 { ok: true } so the endpoint does not reveal whether an email is registered.
 *   - Rate-limited per IP via Cloudflare KV (3 requests / 10 minutes).
 *
 * Bindings required (set in wrangler.toml or CF dashboard):
 *   - ALLOWLIST  (KV Namespace)  — keys: lowercased email, values: portal path ("/portal/phw/")
 *   - RATE_LIMIT (KV Namespace)  — transient IP counters
 *
 * Environment variables:
 *   - FROM_EMAIL       e.g. "hello@phoenixmethodseo.com"
 *   - FROM_NAME        e.g. "Phoenix Method"
 *   - SITE_ORIGIN      e.g. "https://phoenixmethodseo.com"
 *
 * MailChannels (free via Cloudflare Workers) handles the actual send.
 */

const ALLOWED_ORIGINS = [
  'https://phoenixmethodseo.com',
  'https://www.phoenixmethodseo.com',
];

const RATE_LIMIT_MAX = 3;         // requests
const RATE_LIMIT_WINDOW = 600;    // seconds (10 minutes)

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function rateLimit(env, ip) {
  const key = `rl:${ip}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_MAX) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildEmail({ to, toName, portalUrl, fromEmail, fromName }) {
  const subject = 'Your Phoenix Method portal link';
  const text = `Hi${toName ? ' ' + toName : ''},

Here's your portal link:
${portalUrl}

Bookmark it — this is your direct access. If you didn't request this, you can safely ignore this email.

— Phoenix Method
hello@phoenixmethodseo.com`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#07070D;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#131320;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 8px;background:linear-gradient(135deg,#FF4D00,#FF8C00,#FFB800);">
          <div style="font-family:'Cinzel',serif;font-size:22px;font-weight:900;color:#fff;letter-spacing:0.04em;">PHOENIX METHOD</div>
        </td></tr>
        <tr><td style="padding:36px;color:#F0EDE6;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#F0EDE6;">Your portal link</h1>
          <p style="margin:0 0 24px;color:#A8A49C;font-size:15px;line-height:1.6;">Tap the button below to open your Phoenix Method client portal. Bookmark it — this is your direct access.</p>
          <p style="margin:0 0 28px;"><a href="${portalUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#FF4D00,#FF8C00);color:#fff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.1em;text-transform:uppercase;border-radius:8px;">Open My Portal &rarr;</a></p>
          <p style="margin:0 0 8px;color:#6B6860;font-size:13px;line-height:1.6;">Or paste this URL in your browser:</p>
          <p style="margin:0 0 24px;color:#A8A49C;font-size:13px;word-break:break-all;">${portalUrl}</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">
          <p style="margin:0;color:#6B6860;font-size:12px;line-height:1.6;">If you didn't request this link, you can safely ignore this email. No action is required.</p>
        </td></tr>
        <tr><td style="padding:20px 36px;background:#0E0E18;color:#6B6860;font-size:12px;text-align:center;">
          Phoenix Method &bull; <a href="mailto:hello@phoenixmethodseo.com" style="color:#FF8C00;text-decoration:none;">hello@phoenixmethodseo.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    personalizations: [{ to: [{ email: to, name: toName || to }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
  };
}

async function sendViaMailChannels(payload) {
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MailChannels ${res.status}: ${body}`);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (!(request.method === 'POST' && url.pathname === '/request')) {
      return json({ ok: false, error: 'not_found' }, 404, corsHeaders);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await rateLimit(env, ip);
    if (!allowed) {
      // Generic response so rate-limiters cannot enumerate accounts.
      return json({ ok: true }, 200, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400, corsHeaders);
    }
    const email = (body.email || '').toString().trim().toLowerCase();
    if (!validEmail(email)) {
      return json({ ok: false, error: 'bad_email' }, 400, corsHeaders);
    }

    // Look up allowlist (KV value: "{"path":"/portal/phw/","name":"PHW"}" OR a plain path string)
    let entry = await env.ALLOWLIST.get(email);
    if (!entry) {
      // Generic success — do NOT reveal whether email is registered.
      return json({ ok: true }, 200, corsHeaders);
    }

    let portalPath = entry;
    let toName = '';
    try {
      const parsed = JSON.parse(entry);
      if (parsed && typeof parsed === 'object') {
        portalPath = parsed.path;
        toName = parsed.name || '';
      }
    } catch { /* plain string */ }

    const portalUrl = `${env.SITE_ORIGIN}${portalPath}`;
    const payload = buildEmail({
      to: email,
      toName,
      portalUrl,
      fromEmail: env.FROM_EMAIL,
      fromName: env.FROM_NAME,
    });

    try {
      await sendViaMailChannels(payload);
    } catch (err) {
      console.error('send failed', err);
      // Still return generic 200 to avoid oracle behavior. Log for you to investigate.
    }

    return json({ ok: true }, 200, corsHeaders);
  },
};
