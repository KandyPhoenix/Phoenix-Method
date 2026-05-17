/**
 * Phoenix AI — SEO Content Autopilot
 *
 * Self-serve SaaS: customer signs up with email, connects a WordPress site
 * (URL + application password), and Phoenix AI researches keywords, writes
 * SEO articles via an LLM, and pushes them to WordPress.
 *
 * Routes:
 *   POST /auth/request                  — { email }; sends magic link
 *   GET  /auth/verify?t=                — sets session cookie, redirects to /app/
 *   GET  /auth/logout                   — clears cookie
 *   GET  /app/                          — dashboard SPA (HTML shell)
 *   GET  /api/me                        — current customer + sites
 *   POST /api/sites                     — { url, appUsername, appPassword }; connect site
 *   DEL  /api/sites/:siteId             — disconnect site
 *   POST /api/sites/:siteId/research    — kick off keyword research (Ahrefs)
 *   GET  /api/sites/:siteId/keywords    — list researched keywords
 *   POST /api/sites/:siteId/generate    — generate one article now (manual)
 *   GET  /api/sites/:siteId/articles    — list generated articles
 *   GET  /api/sites/:siteId/articles/:articleId  — single article detail
 *   scheduled                           — daily cron, processes one article per active site
 *
 * KV layout:
 *   CUSTOMERS: email                       → { email, plan, trialEnds, createdAt }
 *   SITES:     site:<siteId>               → { id, ownerEmail, url, appUsername, appPassword, niche, brandVoice, status, createdAt }
 *              owner:<email>               → [siteId, ...]
 *   KEYWORDS:  kws:<siteId>                → [{ keyword, volume, kd, intent, picked, pickedAt }, ...]
 *   ARTICLES:  art:<siteId>:<articleId>    → { id, siteId, keyword, title, slug, meta, html, status, wpPostId, wpEditUrl, generatedAt, publishedAt, model, tokens }
 *              list:<siteId>               → [articleId, ...]   (newest first)
 *   AUDIT_LOG: log:<siteId>:<ts>           → { event, detail }   (TTL 30d)
 *   RATE_LIMIT: rl:<ip>                    → request count
 */

const COOKIE_NAME = 'phoenix_ai_session';
const MAGIC_TTL_SECONDS = 15 * 60;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 600;
const AUDIT_TTL_SECONDS = 30 * 24 * 3600;
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

// AES-GCM for app passwords (we don't want plaintext WP passwords in KV)
async function aesKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(secret + ':aes'));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptSecret(plain, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TEXT_ENCODER.encode(plain));
  return `${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}
async function decryptSecret(blob, secret) {
  if (!blob || !blob.includes('.')) return null;
  const [ivPart, ctPart] = blob.split('.');
  const iv = Uint8Array.from(b64urlDecode(ivPart), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(b64urlDecode(ctPart), (c) => c.charCodeAt(0));
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ──────────────────────────────────────────────────────────────
// Helpers

function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function nowIso() { return new Date().toISOString(); }
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
async function rateLimitOk(env, ip, max = RATE_LIMIT_MAX) {
  const key = `rl:${ip}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= max) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function audit(env, siteId, event, detail) {
  if (!env.AUDIT_LOG) return;
  const key = `log:${siteId}:${Date.now()}`;
  await env.AUDIT_LOG.put(key, JSON.stringify({ event, detail, at: nowIso() }), { expirationTtl: AUDIT_TTL_SECONDS });
}

// ──────────────────────────────────────────────────────────────
// Data model

async function getOrCreateCustomer(env, email) {
  const existing = await env.CUSTOMERS.get(email);
  if (existing) return JSON.parse(existing);
  const trialDays = parseInt(env.TRIAL_DAYS || '7', 10);
  const customer = {
    email,
    plan: env.DEFAULT_PLAN || 'trial',
    trialEnds: new Date(Date.now() + trialDays * 86400e3).toISOString(),
    createdAt: nowIso(),
  };
  await env.CUSTOMERS.put(email, JSON.stringify(customer));
  return customer;
}

async function listSitesForOwner(env, email) {
  const idsRaw = await env.SITES.get(`owner:${email}`);
  const ids = idsRaw ? JSON.parse(idsRaw) : [];
  const sites = await Promise.all(ids.map(async (id) => {
    const raw = await env.SITES.get(`site:${id}`);
    return raw ? JSON.parse(raw) : null;
  }));
  return sites.filter(Boolean).map(stripSiteSecrets);
}
function stripSiteSecrets(site) {
  const { appPassword, gsc, anthropicApiKey, githubToken, ...safe } = site;
  return {
    ...safe,
    hasCredentials: Boolean(appPassword) || site.cms === 'manual' || (site.cms === 'github-pages' && Boolean(githubToken)),
    gsc: gsc ? { property: gsc.property || '', connected: true, connectedAt: gsc.connectedAt || null } : null,
    hasAnthropicKey: Boolean(anthropicApiKey),
    hasGithubToken: Boolean(githubToken),
  };
}
async function getSite(env, siteId, owner) {
  const raw = await env.SITES.get(`site:${siteId}`);
  if (!raw) return null;
  const site = JSON.parse(raw);
  if (owner && site.ownerEmail !== owner) return null;
  return site;
}
async function saveSite(env, site) {
  await env.SITES.put(`site:${site.id}`, JSON.stringify(site));
}
async function addSiteToOwner(env, email, siteId) {
  const raw = await env.SITES.get(`owner:${email}`);
  const ids = raw ? JSON.parse(raw) : [];
  if (!ids.includes(siteId)) ids.push(siteId);
  await env.SITES.put(`owner:${email}`, JSON.stringify(ids));
}
async function removeSiteFromOwner(env, email, siteId) {
  const raw = await env.SITES.get(`owner:${email}`);
  const ids = raw ? JSON.parse(raw) : [];
  await env.SITES.put(`owner:${email}`, JSON.stringify(ids.filter((id) => id !== siteId)));
}

// ──────────────────────────────────────────────────────────────
// Site learning — pulls homepage HTML to infer niche + brand voice

async function learnSite(siteUrl) {
  try {
    const res = await fetch(siteUrl, { headers: { 'User-Agent': 'PhoenixAI/1.0 (+https://phoenixmethodseo.com/phoenix-ai/)' }, redirect: 'follow' });
    if (!res.ok) return { niche: '', brandVoice: '', sample: '' };
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ''])[1].trim();
    const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [, ''])[1].trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    return { niche: `${title} — ${description}`.trim(), brandVoice: text, sample: text.slice(0, 2000) };
  } catch (err) {
    return { niche: '', brandVoice: '', sample: '', error: String(err) };
  }
}

// ──────────────────────────────────────────────────────────────
// Pipeline: keyword research (Ahrefs API v3)

async function ahrefsKeywords(env, niche, domain) {
  if (!env.AHREFS_API_KEY) {
    // Fallback: stubbed keyword list derived from niche so the pipeline still
    // works in dev environments without an Ahrefs key. Real keys produce real
    // research; this is just enough to keep the article generator unblocked.
    const seed = (niche || domain || 'business').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 4);
    const base = seed.join(' ') || 'small business';
    return [
      { keyword: `best ${base} services`, volume: 1200, kd: 18, intent: 'commercial' },
      { keyword: `how to choose a ${base} provider`, volume: 900, kd: 14, intent: 'informational' },
      { keyword: `${base} pricing guide`, volume: 700, kd: 12, intent: 'commercial' },
      { keyword: `${base} vs alternatives`, volume: 500, kd: 16, intent: 'commercial' },
      { keyword: `${base} checklist`, volume: 400, kd: 10, intent: 'informational' },
      { keyword: `${base} mistakes to avoid`, volume: 350, kd: 9, intent: 'informational' },
    ];
  }
  // Real Ahrefs v3 call: keywords-explorer matching terms for the niche seed.
  const seed = (niche || domain).split(/[—\-|]/)[0].trim().slice(0, 80) || 'small business';
  const params = new URLSearchParams({
    keywords: seed,
    country: 'us',
    limit: '50',
    select: 'keyword,volume,difficulty,intent',
    order_by: 'volume:desc',
  });
  const res = await fetch(`https://api.ahrefs.com/v3/keywords-explorer/matching-terms?${params}`, {
    headers: { 'Authorization': `Bearer ${env.AHREFS_API_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    console.error('ahrefs failed', res.status, await res.text().catch(() => ''));
    return [];
  }
  const data = await res.json().catch(() => ({}));
  const rows = (data.keywords || data.data || data.results || []).slice(0, 30);
  return rows.map((r) => ({
    keyword: r.keyword || r.term,
    volume: r.volume || r.search_volume || 0,
    kd: r.difficulty || r.keyword_difficulty || 0,
    intent: r.intent || (Array.isArray(r.intents) ? r.intents[0] : 'informational'),
  })).filter((k) => k.keyword);
}

function scoreKeyword(k) {
  // Buyer-intent first, then opportunity (high volume / low difficulty).
  const intentBonus = k.intent === 'commercial' || k.intent === 'transactional' ? 50 : 0;
  const kd = Math.max(1, k.kd || 1);
  return intentBonus + Math.log2((k.volume || 0) + 1) * 10 - kd;
}

async function researchAndStoreKeywords(env, site) {
  const source = site.keywordSource || 'gsc';
  let raw = [];
  let usedSource = source;
  if (source === 'gsc') {
    if (site.gsc && site.gsc.property) {
      raw = await gscKeywords(env, site);
    } else {
      raw = await manualKeywords(site, []);
      usedSource = 'seed';
    }
  } else if (source === 'ahrefs') {
    raw = await ahrefsKeywords(env, site.niche, new URL(site.url).hostname);
  } else if (source === 'manual') {
    raw = await manualKeywords(site, site.manualKeywords || []);
  }
  // Universal fallback: if the primary source produced nothing (new GSC with
  // no rank-eligible queries, Ahrefs API quota, empty manual list…), seed the
  // queue with niche-derived keywords. Better to give the customer something
  // to look at and a working Generate button than a blank queue.
  if (!raw.length) {
    raw = await manualKeywords(site, []);
    usedSource = source + '-seed-fallback';
  }
  const ranked = raw
    .map((k) => ({ ...k, score: scoreKeyword(k), picked: false, pickedAt: null }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
  await env.KEYWORDS.put(`kws:${site.id}`, JSON.stringify(ranked));
  await audit(env, site.id, 'keywords.refreshed', { count: ranked.length, source: usedSource });
  return { list: ranked, source: usedSource };
}

async function manualKeywords(site, seeds) {
  if (Array.isArray(seeds) && seeds.length) {
    return seeds.map((s) => {
      const k = typeof s === 'string' ? { keyword: s } : s;
      return {
        keyword: String(k.keyword || '').trim(),
        volume: k.volume || 0,
        kd: k.kd || 0,
        intent: k.intent || 'informational',
      };
    }).filter((k) => k.keyword);
  }
  // No seeds: derive from site niche so the pipeline isn't blocked.
  const niche = (site.niche || new URL(site.url).hostname || 'business').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ') || 'small business';
  return [
    { keyword: `best ${niche} services`, volume: 0, kd: 0, intent: 'commercial' },
    { keyword: `how to choose a ${niche} provider`, volume: 0, kd: 0, intent: 'informational' },
    { keyword: `${niche} pricing guide`, volume: 0, kd: 0, intent: 'commercial' },
    { keyword: `${niche} checklist`, volume: 0, kd: 0, intent: 'informational' },
  ];
}

async function pickNextKeyword(env, siteId) {
  const raw = await env.KEYWORDS.get(`kws:${siteId}`);
  if (!raw) return null;
  const list = JSON.parse(raw);
  const next = list.find((k) => !k.picked);
  if (!next) return null;
  next.picked = true;
  next.pickedAt = nowIso();
  await env.KEYWORDS.put(`kws:${siteId}`, JSON.stringify(list));
  return next;
}

// ──────────────────────────────────────────────────────────────
// GSC OAuth + keyword research (Google Search Console)

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function googleRedirectUri(url) {
  return `${url.origin}/auth/google/callback`;
}

// Build the Google consent URL the customer is sent to.
async function googleAuthUrl(env, url, siteId, ownerEmail) {
  const stateExp = Math.floor(Date.now() / 1000) + 10 * 60;
  const state = await signToken({ kind: 'gsc', siteId, ownerEmail, exp: stateExp }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(url),
    response_type: 'code',
    scope: GSC_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeGoogleCode(env, code, url) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: googleRedirectUri(url),
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();  // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshGoogleToken(env, refreshTokenPlain) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshTokenPlain,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`google refresh ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();  // { access_token, expires_in, scope, token_type } — no new refresh_token
}

// Returns a fresh access token for the site, refreshing if needed and persisting
// the new expiry. Throws if the site has no GSC connection.
async function gscAccessToken(env, site) {
  if (!site.gsc || !site.gsc.refreshToken) throw new Error('site is not connected to GSC');
  const skewMs = 60 * 1000;
  if (site.gsc.accessToken && site.gsc.expiresAt && site.gsc.expiresAt - skewMs > Date.now()) {
    return decryptSecret(site.gsc.accessToken, env.SESSION_SECRET);
  }
  const refreshTokenPlain = await decryptSecret(site.gsc.refreshToken, env.SESSION_SECRET);
  const tok = await refreshGoogleToken(env, refreshTokenPlain);
  site.gsc.accessToken = await encryptSecret(tok.access_token, env.SESSION_SECRET);
  site.gsc.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  await saveSite(env, site);
  return tok.access_token;
}

// List GSC properties the connected Google account can access.
async function listGscProperties(env, site) {
  const accessToken = await gscAccessToken(env, site);
  const res = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gsc sites ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

// Pull last 90 days of search analytics, filter to "low-hanging fruit" queries
// (position 5–20, decent impressions), and shape into our keyword schema.
async function gscKeywords(env, site) {
  const accessToken = await gscAccessToken(env, site);
  const property = site.gsc.property;
  if (!property) return [];

  const today = new Date();
  const startDate = new Date(today.getTime() - 90 * 86400e3);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const body = JSON.stringify({
    startDate: fmt(startDate),
    endDate: fmt(today),
    dimensions: ['query'],
    rowLimit: 250,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    console.error('gsc query failed', res.status, (await res.text()).slice(0, 300));
    return [];
  }
  const data = await res.json();
  const allRows = data.rows || [];
  // Tiered filter — start with the ideal "missed clicks" sweet spot (rank 5–20
  // with real impression volume), then progressively broaden if the site is
  // too new/small to surface anything at that threshold. Better to give the
  // customer some real GSC data than nothing.
  let rows = allRows.filter((r) => r.position >= 5 && r.position <= 20 && r.impressions >= 10);
  if (!rows.length) rows = allRows.filter((r) => r.position >= 3 && r.position <= 30 && r.impressions >= 3);
  if (!rows.length) rows = allRows.filter((r) => r.impressions >= 1);
  return rows
    .map((r) => {
      const ctr = r.ctr || 0;
      // Keep our schema consistent: keyword/volume/kd/intent/score-style fields.
      // For GSC: impressions stand in for "volume", missed clicks
      // (impressions × (1 − ctr)) is the opportunity score input.
      return {
        keyword: r.keys[0],
        volume: Math.round(r.impressions),
        kd: Math.round(r.position),
        intent: 'informational',
        opportunity: Math.round(Math.max(1, r.impressions) * (1 - ctr)),
      };
    })
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, 50);
}

// ──────────────────────────────────────────────────────────────
// Pipeline: article generation (LLM)

function buildArticlePrompt({ keyword, site }) {
  const intent = (keyword.intent || 'informational').toLowerCase();
  const niche = site.niche || 'general business';
  // brandVoiceOverride is a manually-curated paragraph that takes precedence
  // over the auto-crawled homepage sample. Used for clients whose existing
  // site doesn't represent the voice we want (thin content, placeholder copy,
  // or YMYL clients where we want to control tone tightly).
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 1500);
  return {
    system: `You are a senior SEO content writer at Phoenix Method, a working SEO agency. Your job is to write a single long-form article that ranks on Google and converts readers.

Style guardrails:
- 1,200–1,600 words.
- Plain English, no SEO-speak, no keyword stuffing, no marketing fluff.
- Match the brand voice sample given to you in word choice, sentence rhythm, and POV.
- Use proper H-hierarchy: one H1 (matches title), 4–8 H2s, optional H3s.
- Open with a punchy 2–3 sentence intro that answers the core question immediately.
- Do NOT include an FAQ or "Frequently Asked Questions" section in the html field. The Q&As go in the separate faqs JSON field below — the dashboard renders them visually beneath the article. Putting them in both places wastes tokens and risks truncation.
- Cite a source by name when stating a statistic (don't fabricate numbers — if you don't know one, drop the stat).
- Never use the word "delve". Avoid corporate buzzwords ("leverage", "synergy", "unlock", "elevate").
- No em-dash overuse. No bullet-list spam — only when listing actual discrete items.

You MUST respond with a single JSON object (no prose, no code fences) matching this schema exactly:
{
  "title":        string  // SEO meta title, 50–60 chars
  "slug":         string  // url-safe slug
  "metaDescription": string  // 140–160 chars
  "html":         string  // article body as HTML (no <html>/<head>/<body>, no FAQ section, just content starting with <p> or <h2>)
  "tags":         string[]  // 3–6 tags
  "faqs":         [{ "q": string, "a": string }]  // exactly 3 entries; rendered by the dashboard, NOT in the html field above
  "imagePrompt":  string  // 1–2 sentence visual brief for an editorial hero image. Describe the SCENE concretely (objects, setting, lighting, mood) — not the article topic abstractly. No text overlays, no faces, no logos. Style hint: "editorial photograph" OR "minimal illustration" depending on what fits the topic.
}`,
    user: `Write the article for this target:

Target keyword: "${keyword.keyword}"
Search intent: ${intent}
Search volume: ${keyword.volume || 'unknown'}
Keyword difficulty: ${keyword.kd || 'unknown'}/100

Site niche: ${niche}
Site URL: ${site.url}

Brand voice sample (write in this voice):
"""
${voiceSample}
"""

Return only the JSON object.`,
  };
}

// Repair pass for LLM-emitted JSON: walks the string tracking quote/escape
// state, and inside string literals replaces raw control chars (0x00-0x1F)
// with their valid JSON escape (\n, \r, \t, or \uXXXX). Llama 8B routinely
// emits raw newlines inside the html string field, which makes strict
// JSON.parse fail at the first newline.
function escapeUnescapedControlChars(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    }
    out += ch;
  }
  return out;
}

// Single entry point. Picks Workers AI (free, default) or BYOK Anthropic
// based on what the site is configured for. Never falls back to a
// worker-paid provider — Phoenix AI's business model is that customer
// generation never costs Kandy uncapped tokens.
async function callLLM(env, site, { system, user }) {
  const provider = site.llmProvider === 'anthropic' && site.anthropicApiKey
    ? 'anthropic' : 'workers-ai';
  if (provider === 'anthropic') return callAnthropic(env, site, { system, user });
  return callWorkersAI(env, { system, user });
}

// Llama 3.1 8B Instruct Fast is widely available across Workers AI accounts
// and completes within Cloudflare's 30s worker CPU budget for our prompt size
// (~1500-2000 word article). Llama 3.3 70B fp8-fast produces higher-quality
// articles but routinely exceeds 30s and gets canceled. When we move article
// generation to a queue/durable-object (async, no time limit), the default
// can move back to the 70B model.
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

async function callWorkersAI(env, { system, user }) {
  if (!env.AI) return { ok: false, error: 'Workers AI binding is not configured on this worker' };
  try {
    const result = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 4000,
    });
    // env.AI.run returns either { response: <string> } or a raw string
    // depending on the model. Normalize, then parse JSON from the text.
    const raw = result.response ?? result;
    const text = typeof raw === 'string' ? raw : (raw && raw.text) || String(raw);
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (err) {
      // Workers AI 8B models sometimes emit literal newlines / tabs / other
      // control chars inside JSON string values (the html field is the usual
      // offender). Strict JSON.parse rejects them. Try three repair passes
      // before giving up: extract the first {...} block, then escape
      // unescaped control chars inside string literals, then both combined.
      const candidates = [];
      const blockMatch = cleaned.match(/\{[\s\S]*\}/);
      if (blockMatch) candidates.push(blockMatch[0]);
      candidates.push(escapeUnescapedControlChars(cleaned));
      if (blockMatch) candidates.push(escapeUnescapedControlChars(blockMatch[0]));
      let recovered = null;
      for (const c of candidates) {
        try { recovered = JSON.parse(c); break; } catch { /* try next */ }
      }
      if (!recovered) {
        // Diagnostic: surface the bytes around the failure so we can tell
        // exactly what the model emitted that none of the repairs handled.
        const pos = (err.message.match(/position (\d+)/) || [])[1];
        const ctx = pos ? cleaned.slice(Math.max(0, pos - 60), Math.min(cleaned.length, +pos + 60)) : cleaned.slice(0, 200);
        const bytesView = ctx.split('').map((c) => {
          const code = c.charCodeAt(0);
          if (code < 0x20) return `[U+${code.toString(16).padStart(4, '0')}]`;
          return c;
        }).join('');
        return {
          ok: false,
          error: `Workers AI returned non-JSON: ${err.message}. Context around pos: «${bytesView}». Total len: ${cleaned.length}`,
          raw: cleaned.slice(0, 500),
        };
      }
      parsed = recovered;
    }
    return {
      ok: true,
      content: parsed,
      tokens: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
      model: WORKERS_AI_MODEL,
    };
  } catch (err) {
    return { ok: false, error: `Workers AI error: ${err.message || err}` };
  }
}

async function callAnthropic(env, site, { system, user }) {
  const apiKey = await decryptSecret(site.anthropicApiKey, env.SESSION_SECRET);
  if (!apiKey) return { ok: false, error: 'BYOK Anthropic key is missing or unreadable for this site' };
  const model = site.anthropicModel || 'claude-opus-4-7';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Anthropic ${res.status}: ${errBody.slice(0, 400)}` };
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (err) { return { ok: false, error: `failed to parse model output: ${err.message}`, raw: text.slice(0, 500) }; }
  return {
    ok: true,
    content: parsed,
    tokens: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
    model,
  };
}

// ──────────────────────────────────────────────────────────────
// Pipeline: WordPress REST publish

async function wpPublish(env, site, article, status = 'draft') {
  const appPassword = await decryptSecret(site.appPassword, env.SESSION_SECRET);
  if (!appPassword || !site.appUsername) return { ok: false, error: 'missing WP credentials' };

  const base = site.url.replace(/\/+$/, '');
  const endpoint = `${base}/wp-json/wp/v2/posts`;
  const auth = 'Basic ' + btoa(`${site.appUsername}:${appPassword}`);

  const payload = {
    title: article.title,
    slug: article.slug,
    content: article.html,
    excerpt: article.metaDescription,
    status,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `wp ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  return {
    ok: true,
    wpPostId: data.id,
    wpEditUrl: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
    publicUrl: data.link,
  };
}

// ──────────────────────────────────────────────────────────────
// Pipeline: GitHub Pages publish (commits /blog/<slug>.html + updates /blog/index.html
// in the customer's repo via the GitHub Contents API). GitHub Pages auto-rebuilds.

const GITHUB_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'phoenix-ai',
    'Content-Type': 'application/json',
  };
}

// btoa() in workers handles latin1 only; this safely base64s UTF-8 text.
function b64utf8(str) {
  let bin = '';
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function utf8FromB64(b64) {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function blogPostHTML({ site, article, faqHtml, imageUrl }) {
  // Minimal blog post template. Includes /assets/site-chrome.{css,js} so if
  // the customer's repo has them (like phoenixmethodseo.com does), the page
  // automatically inherits their site's nav + footer + design tokens. If
  // those files don't exist in the repo, the inline fallback styles still
  // produce a readable page.
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleEsc = escape(article.title || '');
  const descEsc = escape(article.metaDescription || '');
  const canonical = `${site.url.replace(/\/+$/, '')}/${site.blogPath || 'blog'}/${article.slug}.html`;
  const absImage = imageUrl ? `${site.url.replace(/\/+$/, '')}${imageUrl}` : '';
  const ogImage = absImage
    ? `<meta property="og:image" content="${absImage}">\n<meta property="og:image:width" content="1024">\n<meta property="og:image:height" content="1024">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${absImage}">`
    : '';
  const heroFigure = imageUrl
    ? `<figure class="hero"><img src="${imageUrl}" alt="${titleEsc}" loading="eager" width="1024" height="1024"></figure>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleEsc}</title>
<meta name="description" content="${descEsc}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${titleEsc}">
<meta property="og:description" content="${descEsc}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
${ogImage}
<link rel="stylesheet" href="/assets/site-chrome.css">
<style>
  body { font-family: 'Outfit', system-ui, sans-serif; line-height: 1.7; background: #07070D; color: #E8E8F0; margin: 0; }
  .blog-post { max-width: 720px; margin: 60px auto; padding: 0 24px; }
  .blog-post .hero { margin: 0 0 28px; }
  .blog-post .hero img { width: 100%; height: auto; border-radius: 12px; display: block; }
  .blog-post h1 { font-family: 'Cinzel', serif; font-size: 2rem; margin-bottom: 8px; }
  .blog-post .meta { color: #8888A0; font-size: 0.88rem; margin-bottom: 32px; }
  .blog-post h2 { font-family: 'Cinzel', serif; margin-top: 36px; margin-bottom: 12px; }
  .blog-post h3 { font-family: 'Outfit', sans-serif; margin-top: 24px; margin-bottom: 8px; }
  .blog-post p { margin-bottom: 16px; }
  .blog-post a { color: #FF8C00; }
  .blog-post ul, .blog-post ol { margin: 0 0 16px 24px; }
  .blog-post .back { display: inline-block; margin-bottom: 24px; color: #8888A0; }
</style>
</head>
<body>
<div id="pm-nav"></div>
<main class="blog-post">
<p class="back"><a href="/${site.blogPath || 'blog'}/">← All articles</a></p>
<h1>${titleEsc}</h1>
<p class="meta">Published ${new Date().toISOString().slice(0, 10)} · ${(article.tags || []).slice(0, 4).map(escape).join(' · ')}</p>
${heroFigure}
${article.html || ''}
${faqHtml}
</main>
<div id="pm-footer"></div>
<script src="/assets/site-chrome.js" defer></script>
</body>
</html>
`;
}

function blogIndexHTML({ site, articles }) {
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const items = articles.map((a) => {
    const thumb = a.imageUrl ? `<img src="${a.imageUrl}" alt="" loading="lazy" width="240" height="240">` : '';
    return `<li><a href="/${site.blogPath || 'blog'}/${a.slug}.html">${thumb}<div class="entry-text"><h2>${escape(a.title)}</h2><p>${escape(a.metaDescription || '')}</p><p class="meta">${a.publishedAt ? a.publishedAt.slice(0, 10) : ''}</p></div></a></li>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blog</title>
<meta name="description" content="Articles, guides, and updates.">
<link rel="stylesheet" href="/assets/site-chrome.css">
<style>
  body { font-family: 'Outfit', system-ui, sans-serif; line-height: 1.7; background: #07070D; color: #E8E8F0; margin: 0; }
  .blog-index { max-width: 720px; margin: 60px auto; padding: 0 24px; }
  .blog-index > h1 { font-family: 'Cinzel', serif; font-size: 2.2rem; margin-bottom: 32px; }
  .blog-index ul { list-style: none; padding: 0; }
  .blog-index li { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 22px 0; }
  .blog-index li a { display: grid; grid-template-columns: 120px 1fr; gap: 18px; color: inherit; text-decoration: none; align-items: center; }
  .blog-index li a:not(:has(img)) { grid-template-columns: 1fr; }
  .blog-index li img { width: 120px; height: 120px; object-fit: cover; border-radius: 8px; }
  .blog-index li h2 { font-family: 'Cinzel', serif; font-size: 1.3rem; margin-bottom: 6px; }
  .blog-index li p { color: #8888A0; margin: 0 0 4px; }
  .blog-index li .meta { font-size: 0.82rem; color: #555570; }
  .blog-index li a:hover h2 { color: #FF8C00; }
  @media (max-width: 540px) { .blog-index li a { grid-template-columns: 1fr; } .blog-index li img { width: 100%; height: 200px; } }
</style>
</head>
<body>
<div id="pm-nav"></div>
<main class="blog-index">
<h1>Blog</h1>
<!--PHOENIX-AI-MANIFEST:${b64utf8(JSON.stringify(articles))}:END-->
<ul>
${items}
</ul>
</main>
<div id="pm-footer"></div>
<script src="/assets/site-chrome.js" defer></script>
</body>
</html>
`;
}

function parseIndexManifest(html) {
  // Returns the list previously embedded by blogIndexHTML, or [] if missing.
  const m = html.match(/<!--PHOENIX-AI-MANIFEST:([A-Za-z0-9+/=]+):END-->/);
  if (!m) return [];
  try { return JSON.parse(utf8FromB64(m[1])); }
  catch { return []; }
}

async function ghGetFile(token, owner, repo, branch, filePath) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return { ok: true, exists: false };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `github ${res.status} on GET ${filePath}: ${body.slice(0, 300)}` };
  }
  const data = await res.json();
  return { ok: true, exists: true, sha: data.sha, content: utf8FromB64(data.content || '') };
}

async function ghPutFile(token, owner, repo, branch, filePath, body, message, sha) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`;
  const payload = { message, content: b64utf8(body), branch };
  if (sha) payload.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `github ${res.status} on PUT ${filePath}: ${errBody.slice(0, 300)}` };
  }
  return { ok: true };
}

// Same as ghPutFile but the caller passes already-base64-encoded content
// (e.g., the raw output from a Workers AI image model). Saves a decode/encode
// round-trip on binary payloads.
async function ghPutBase64File(token, owner, repo, branch, filePath, base64Body, message, sha) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`;
  const payload = { message, content: base64Body, branch };
  if (sha) payload.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `github ${res.status} on PUT (binary) ${filePath}: ${errBody.slice(0, 300)}` };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────
// Hero image generation (Workers AI FLUX.1 schnell). Free, fast (~5-10s),
// 1024x1024 PNG. The LLM produces an imagePrompt as part of the article
// JSON; if it's missing we fall back to a generic editorial prompt built
// from the article title.

async function generateHeroImage(env, article) {
  const prompt = (article.imagePrompt && article.imagePrompt.trim())
    || `Editorial hero illustration for an article titled "${article.title}". Clean, professional, soft natural lighting, minimal composition. No text, no faces, no logos.`;
  try {
    const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
    // Workers AI returns { image: "<base64 jpg>" } for FLUX in 2026. Defensively
    // also handle ArrayBuffer / Uint8Array shapes (older response formats).
    if (response && typeof response.image === 'string') {
      return { ok: true, base64: response.image, contentType: 'image/jpeg' };
    }
    if (response instanceof ArrayBuffer || response instanceof Uint8Array) {
      const bytes = response instanceof Uint8Array ? response : new Uint8Array(response);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { ok: true, base64: btoa(bin), contentType: 'image/png' };
    }
    return { ok: false, error: 'unexpected FLUX response shape' };
  } catch (err) {
    return { ok: false, error: `FLUX error: ${String(err.message || err).slice(0, 200)}` };
  }
}

async function githubPagesPublish(env, site, article, status = 'draft') {
  if (status === 'draft') {
    // requireApproval — article stays in our KV with status=draft, no commit
    // happens until the customer hits Approve. Mirrors WordPress behavior.
    return { ok: true, publicUrl: null };
  }
  const token = await decryptSecret(site.githubToken, env.SESSION_SECRET);
  if (!token) return { ok: false, error: 'missing GitHub PAT for this site' };
  if (!site.repoOwner || !site.repoName) return { ok: false, error: 'missing GitHub repo coordinates for this site' };
  const branch = site.branch || 'main';
  const blogPath = site.blogPath || 'blog';

  // 0. Generate + commit hero image (FLUX). Skipped if site.imageGeneration === 'off'.
  // Image failure is non-fatal: the article still publishes, just without a hero.
  // We only re-generate if no image file exists for this slug yet (idempotent
  // re-runs don't burn FLUX time or shuffle visuals on the customer's blog).
  let imageUrl = null;
  const imgMode = site.imageGeneration || 'flux';
  if (imgMode === 'flux') {
    const imgPath = `${blogPath}/images/${article.slug}.jpg`;
    const existingImg = await ghGetFile(token, site.repoOwner, site.repoName, branch, imgPath);
    if (existingImg.ok && existingImg.exists) {
      imageUrl = `/${imgPath}`;
    } else if (existingImg.ok) {
      const img = await generateHeroImage(env, article);
      if (img.ok) {
        const imgPut = await ghPutBase64File(
          token, site.repoOwner, site.repoName, branch, imgPath, img.base64,
          `Phoenix AI: hero image for ${article.slug}`,
        );
        if (imgPut.ok) {
          imageUrl = `/${imgPath}`;
        } else {
          await audit(env, site.id, 'pipeline.image.commit_failed', { slug: article.slug, error: imgPut.error });
        }
      } else {
        await audit(env, site.id, 'pipeline.image.gen_failed', { slug: article.slug, error: img.error });
      }
    }
  }

  const faqHtml = (article.faqs && article.faqs.length)
    ? '<h2>Frequently Asked Questions</h2>' + article.faqs.map((f) => `<h3>${String(f.q || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</h3><p>${String(f.a || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`).join('')
    : '';
  const postHtml = blogPostHTML({ site, article, faqHtml, imageUrl });
  const postPath = `${blogPath}/${article.slug}.html`;

  // 1. Check if the article file already exists (re-publish/edit case).
  const existing = await ghGetFile(token, site.repoOwner, site.repoName, branch, postPath);
  if (!existing.ok) return existing;

  // 2. PUT the article file.
  const put = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, postPath, postHtml,
    `Phoenix AI: ${existing.exists ? 'update' : 'publish'} ${article.slug}`,
    existing.sha,
  );
  if (!put.ok) return put;

  // 3. Update the blog index. Parse the embedded manifest, prepend the new
  // article (or replace if same slug already there), re-render, PUT back.
  const indexPath = `${blogPath}/index.html`;
  const idx = await ghGetFile(token, site.repoOwner, site.repoName, branch, indexPath);
  if (!idx.ok) return idx;
  const prev = idx.exists ? parseIndexManifest(idx.content) : [];
  const filtered = prev.filter((a) => a.slug !== article.slug);
  const updated = [{
    slug: article.slug,
    title: article.title,
    metaDescription: article.metaDescription || '',
    publishedAt: nowIso(),
    imageUrl,
  }, ...filtered].slice(0, 200);
  const newIndex = blogIndexHTML({ site, articles: updated });
  const idxPut = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, indexPath, newIndex,
    `Phoenix AI: update blog index (${article.slug})`,
    idx.sha,
  );
  if (!idxPut.ok) return idxPut;

  const publicUrl = `${site.url.replace(/\/+$/, '')}/${blogPath}/${article.slug}.html`;
  const editUrl = `https://github.com/${site.repoOwner}/${site.repoName}/edit/${branch}/${postPath}`;
  return { ok: true, publicUrl, wpEditUrl: editUrl, wpPostId: null, imageUrl };
}

// ──────────────────────────────────────────────────────────────
// Pipeline: full run

async function runPipeline(env, site, opts = {}) {
  const startedAt = nowIso();
  await audit(env, site.id, 'pipeline.start', { manual: Boolean(opts.manual) });

  // 1. Make sure we have keywords to pick from.
  let kwListRaw = await env.KEYWORDS.get(`kws:${site.id}`);
  let kwList = kwListRaw ? JSON.parse(kwListRaw) : [];
  if (!kwList.length || kwList.every((k) => k.picked)) {
    const refreshed = await researchAndStoreKeywords(env, site);
    kwList = refreshed.list;
  }

  // 2. Pick the next keyword.
  const keyword = await pickNextKeyword(env, site.id);
  if (!keyword) {
    await audit(env, site.id, 'pipeline.error', { reason: 'no keywords available' });
    return { ok: false, error: 'No keywords available for this site.' };
  }

  // 3. Generate article via the LLM.
  const prompt = buildArticlePrompt({ keyword, site });
  const llmResult = await callLLM(env, site, prompt);
  if (!llmResult.ok) {
    await audit(env, site.id, 'pipeline.error', { stage: 'llm', error: llmResult.error });
    return { ok: false, error: llmResult.error };
  }
  const article = llmResult.content;

  // 4. Publish to the configured destination. requireApproval locks the site
  // to draft-only — autoPublish has no effect when this is on. Used for YMYL
  // (healthcare, finance, legal) clients where every article must be reviewed
  // before going live. The publish step's return shape is the same across
  // CMS adapters: { ok, publicUrl?, wpPostId?, wpEditUrl?, error? }.
  let publishStatus, wpResult;
  if (site.cms === 'manual') {
    publishStatus = 'ready';
    wpResult = { ok: true };
  } else if (site.cms === 'github-pages') {
    publishStatus = (!site.requireApproval && site.autoPublish) ? 'publish' : 'draft';
    wpResult = await githubPagesPublish(env, site, article, publishStatus);
  } else {
    publishStatus = (!site.requireApproval && site.autoPublish) ? 'publish' : 'draft';
    wpResult = await wpPublish(env, site, article, publishStatus);
  }

  // 5. Persist article record.
  const articleId = uuid();
  const record = {
    id: articleId,
    siteId: site.id,
    keyword: keyword.keyword,
    title: article.title,
    slug: article.slug,
    metaDescription: article.metaDescription,
    html: article.html,
    tags: article.tags || [],
    faqs: article.faqs || [],
    status: wpResult.ok ? publishStatus : 'failed',
    wpPostId: wpResult.wpPostId || null,
    wpEditUrl: wpResult.wpEditUrl || null,
    publicUrl: wpResult.publicUrl || null,
    imageUrl: wpResult.imageUrl || null,
    imagePrompt: article.imagePrompt || null,
    publishError: wpResult.ok ? null : wpResult.error,
    generatedAt: startedAt,
    publishedAt: wpResult.ok ? nowIso() : null,
    model: llmResult.model,
    tokens: llmResult.tokens,
    manual: Boolean(opts.manual),
  };
  await env.ARTICLES.put(`art:${site.id}:${articleId}`, JSON.stringify(record));

  // Maintain a per-site newest-first index.
  const indexRaw = await env.ARTICLES.get(`list:${site.id}`);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.unshift(articleId);
  await env.ARTICLES.put(`list:${site.id}`, JSON.stringify(index.slice(0, 500)));

  await audit(env, site.id, 'pipeline.done', { articleId, keyword: keyword.keyword, wpOk: wpResult.ok });

  return { ok: true, article: record };
}

// ──────────────────────────────────────────────────────────────
// Email (Resend)

function emailTemplate({ magicUrl }) {
  const subject = `Your Phoenix AI sign-in link`;
  const text = `Click this link to sign in to Phoenix AI:

${magicUrl}

This link is valid for 15 minutes. After you sign in, your browser will remember you for 30 days.

If you didn't request this, you can safely ignore it.

— Phoenix AI
hello@phoenixmethodseo.com`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#07070D;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#131320;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
      <tr><td style="padding:32px 36px 8px;background:linear-gradient(135deg,#FF4D00,#FF8C00,#FFB800);">
        <div style="font-family:'Cinzel',serif;font-size:22px;font-weight:900;color:#fff;letter-spacing:0.04em;">PHOENIX AI</div>
      </td></tr>
      <tr><td style="padding:36px;color:#F0EDE6;">
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#F0EDE6;">Your sign-in link</h1>
        <p style="margin:0 0 24px;color:#A8A49C;font-size:15px;line-height:1.6;">Click below to sign in to your Phoenix AI dashboard. This link is valid for 15 minutes.</p>
        <p style="margin:0 0 28px;"><a href="${magicUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#FF4D00,#FF8C00);color:#fff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;border-radius:8px;">Sign in to Phoenix AI &rarr;</a></p>
        <p style="margin:0 0 8px;color:#6B6860;font-size:13px;line-height:1.6;">Or paste this URL in your browser:</p>
        <p style="margin:0 0 24px;color:#A8A49C;font-size:13px;word-break:break-all;">${magicUrl}</p>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">
        <p style="margin:0;color:#6B6860;font-size:12px;line-height:1.6;">If you didn't request this, ignore it — your account stays safe.</p>
      </td></tr>
      <tr><td style="padding:20px 36px;background:#0E0E18;color:#6B6860;font-size:12px;text-align:center;">
        Phoenix AI &bull; <a href="mailto:hello@phoenixmethodseo.com" style="color:#FF8C00;text-decoration:none;">hello@phoenixmethodseo.com</a>
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Permissive CORS for the marketing page calling /auth/request from phoenixmethodseo.com.
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request);

    if (path === '/auth/request' && request.method === 'POST') return cors(await handleAuthRequest(request, env, url), request);
    if (path === '/auth/verify') return await handleAuthVerify(request, env, url);
    if (path === '/auth/logout') return logout();
    if (path === '/auth/google/start') return await handleGoogleStart(request, env, url);
    if (path === '/auth/google/callback') return await handleGoogleCallback(request, env, url);

    if (path.startsWith('/api/')) return cors(await apiRouter(request, env, url, path), request);

    if (path === '/app' || path === '/app/' || path.startsWith('/app/')) {
      return new Response(dashboardHTML(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (path === '/' || path === '') {
      const session = await currentSession(request, env);
      if (session) return Response.redirect(`${url.origin}/app/`, 302);
      // Anonymous: bounce to the marketing page.
      return Response.redirect('https://phoenixmethodseo.com/phoenix-ai/', 302);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Phase 2 entry point: walk every active site and run the pipeline once.
    // Phase 1 leaves this as a no-op so we don't burn API credits before the
    // dashboard is ready.
    if (env.CRON_ENABLED !== 'true') return;
    const list = await env.SITES.list({ prefix: 'site:' });
    for (const k of list.keys) {
      const raw = await env.SITES.get(k.name);
      if (!raw) continue;
      const site = JSON.parse(raw);
      if (site.status !== 'active') continue;
      // Skip sites missing the credentials their CMS needs. Manual sites have
      // no credentials to check — every cron run produces a "ready" article
      // the customer copy/pastes (intentional).
      if (site.cms === 'wordpress' && !site.appPassword) continue;
      if (site.cms === 'github-pages' && !site.githubToken) continue;
      try {
        await runPipeline(env, site, { manual: false });
      } catch (err) {
        await audit(env, site.id, 'pipeline.crash', { error: String(err) });
      }
    }
  },
};

const ALLOWED_ORIGINS = new Set([
  'https://phoenixmethodseo.com',
  'https://www.phoenixmethodseo.com',
]);

function cors(res, request) {
  const origin = request && request.headers ? request.headers.get('Origin') : null;
  const h = new Headers(res.headers);
  // Echo back whichever allowed origin the browser is on (bare domain vs www).
  // GitHub Pages canonically redirects to www, but bookmarks etc. may still
  // hit the bare host.
  h.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.phoenixmethodseo.com');
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Allow-Credentials', 'true');
  return new Response(res.body, { status: res.status, headers: h });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Auth handlers

async function handleAuthRequest(request, env, url) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await rateLimitOk(env, ip))) return json({ ok: true });

  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const email = (body.email || '').toString().trim().toLowerCase();
  if (!validEmail(email)) return new Response('Bad email', { status: 400 });

  // Phoenix AI is self-serve — anyone with a real email can sign up. We
  // upsert the customer record on first sign-in (in handleAuthVerify).
  const exp = Math.floor(Date.now() / 1000) + MAGIC_TTL_SECONDS;
  const token = await signToken({ kind: 'magic', email, exp }, env.SESSION_SECRET);
  const magicUrl = `${url.origin}/auth/verify?t=${encodeURIComponent(token)}`;
  try {
    const { subject, text, html } = emailTemplate({ magicUrl });
    await sendViaResend({ env, to: email, subject, text, html });
  } catch (err) {
    console.error('resend send failed', err);
  }
  return json({ ok: true });
}

async function handleAuthVerify(request, env, url) {
  const token = url.searchParams.get('t');
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload || payload.kind !== 'magic' || !validEmail(payload.email)) {
    return new Response(verifyErrorHTML('This link is expired or invalid. Request a new one from the homepage.'), {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  await getOrCreateCustomer(env, payload.email);
  const sessionDays = parseInt(env.SESSION_DAYS || '30', 10);
  const sessionExp = Math.floor(Date.now() / 1000) + sessionDays * 86400;
  const sessionToken = await signToken({ kind: 'session', email: payload.email, exp: sessionExp }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/app/',
      'Set-Cookie': `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDays * 86400}`,
    },
  });
}

async function handleGoogleStart(request, env, url) {
  const session = await currentSession(request, env);
  if (!session) return Response.redirect('https://phoenixmethodseo.com/phoenix-ai/#waitlist', 302);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(oauthErrorHTML('Google OAuth is not configured on this worker yet. Check back shortly.'), {
      status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const siteId = url.searchParams.get('siteId');
  const site = siteId ? await getSite(env, siteId, session.email) : null;
  if (!site) return new Response('Site not found', { status: 404 });
  const authUrl = await googleAuthUrl(env, url, site.id, session.email);
  return Response.redirect(authUrl, 302);
}

async function handleGoogleCallback(request, env, url) {
  const session = await currentSession(request, env);
  if (!session) {
    return new Response(oauthErrorHTML('Your sign-in session expired during the Google flow. Sign in again, then re-connect GSC.'), {
      status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) {
    return Response.redirect(`${url.origin}/app/?gscError=${encodeURIComponent(error)}`, 302);
  }
  const state = await verifyToken(stateToken, env.SESSION_SECRET);
  if (!state || state.kind !== 'gsc' || state.ownerEmail !== session.email) {
    return new Response(oauthErrorHTML('OAuth state was invalid or expired. Try connecting again from the dashboard.'), {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const site = await getSite(env, state.siteId, session.email);
  if (!site) return new Response('Site not found', { status: 404 });
  if (!code) return new Response('Missing authorization code', { status: 400 });

  let tokens;
  try { tokens = await exchangeGoogleCode(env, code, url); }
  catch (err) {
    await audit(env, site.id, 'gsc.oauth.exchange_failed', { error: String(err) });
    return new Response(oauthErrorHTML('Could not exchange the Google authorization code for tokens. Please try again.'), {
      status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // refresh_token is only returned on first consent (or when prompt=consent
  // forces re-prompt). If it's missing on a re-auth, keep whatever we already
  // had so the connection survives.
  const refreshTokenPlain = tokens.refresh_token || (site.gsc && site.gsc.refreshToken
    ? await decryptSecret(site.gsc.refreshToken, env.SESSION_SECRET)
    : null);
  if (!refreshTokenPlain) {
    return new Response(oauthErrorHTML("Google didn't return a refresh token. Try again — and revoke the previous Phoenix AI grant in your Google account first if needed."), {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  site.gsc = {
    accessToken: await encryptSecret(tokens.access_token, env.SESSION_SECRET),
    refreshToken: await encryptSecret(refreshTokenPlain, env.SESSION_SECRET),
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    property: site.gsc && site.gsc.property ? site.gsc.property : '',
    connectedAt: nowIso(),
  };
  if (!site.keywordSource) site.keywordSource = 'gsc';
  await saveSite(env, site);
  await audit(env, site.id, 'gsc.oauth.connected', {});

  // After connect, send the user back to the dashboard. The SPA will look at
  // ?gscConnected and offer property selection if none picked yet.
  return Response.redirect(`${url.origin}/app/?gscConnected=${site.id}`, 302);
}

function oauthErrorHTML(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Connection error — Phoenix AI</title>
<style>body{font-family:system-ui,sans-serif;background:#07070D;color:#F0EDE6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{background:#131320;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:480px;text-align:center}h1{color:#FF8C00;margin:0 0 12px}p{color:#A8A49C;margin:0 0 18px;line-height:1.6}a{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#FF4D00,#FF8C00);color:#fff;border-radius:8px;text-decoration:none;font-weight:700}</style>
</head><body><div class="card"><h1>Couldn't finish connecting GSC</h1><p>${msg}</p><a href="/app/">Back to dashboard</a></div></body></html>`;
}

// ──────────────────────────────────────────────────────────────
// API router (all routes require a session)

async function apiRouter(request, env, url, path) {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const email = session.email;

  if (path === '/api/me' && request.method === 'GET') {
    const customer = await getOrCreateCustomer(env, email);
    const sites = await listSitesForOwner(env, email);
    return json({ customer, sites });
  }

  if (path === '/api/sites' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const siteUrl = (body.url || '').toString().trim().replace(/\/+$/, '');
    const cms = ['manual', 'github-pages', 'wordpress'].includes(body.cms) ? body.cms : 'wordpress';
    const appUsername = (body.appUsername || '').toString().trim();
    const appPasswordPlain = (body.appPassword || '').toString().trim();
    const brandVoiceOverride = (body.brandVoiceOverride || '').toString().trim().slice(0, 4000);
    // manual-paste mode always implies approval-required — there's no
    // automated publish step, so every article waits on a human anyway.
    const requireApproval = cms === 'manual' ? true : Boolean(body.requireApproval);
    if (!/^https?:\/\//.test(siteUrl)) return json({ error: 'site URL must start with http(s)://' }, 400);
    if (cms === 'wordpress' && (!appUsername || !appPasswordPlain)) {
      return json({ error: 'WordPress username and application password are required' }, 400);
    }
    // GitHub Pages mode requires repo coordinates + a fine-grained PAT.
    const repoOwner = (body.repoOwner || '').toString().trim();
    const repoName = (body.repoName || '').toString().trim();
    const branch = ((body.branch || '').toString().trim() || 'main');
    const blogPath = ((body.blogPath || '').toString().trim() || 'blog').replace(/^\/+|\/+$/g, '');
    const githubTokenPlain = (body.githubToken || '').toString().trim();
    if (cms === 'github-pages' && (!repoOwner || !repoName || !githubTokenPlain)) {
      return json({ error: 'GitHub Pages mode requires repo owner, repo name, and a fine-grained PAT with Contents:write' }, 400);
    }

    const learned = await learnSite(siteUrl);
    const id = uuid();
    // Allow keywordSource to be set at connect time; default to 'gsc' so new
    // customers are nudged toward the free option. They'll click Connect GSC
    // from the dashboard before any real research runs against it.
    const keywordSource = ['gsc', 'ahrefs', 'manual'].includes(body.keywordSource) ? body.keywordSource : 'gsc';
    // LLM provider: 'workers-ai' (free default) or 'anthropic' (BYOK premium).
    // Phoenix AI never pays for customer tokens — Anthropic mode requires the
    // customer to paste their own API key, stored encrypted per-site.
    const llmProvider = body.llmProvider === 'anthropic' ? 'anthropic' : 'workers-ai';
    const anthropicKeyPlain = (body.anthropicApiKey || '').toString().trim();
    const site = {
      id,
      ownerEmail: email,
      url: siteUrl,
      cms,
      appUsername: cms === 'wordpress' ? appUsername : '',
      appPassword: cms === 'wordpress' ? await encryptSecret(appPasswordPlain, env.SESSION_SECRET) : '',
      repoOwner: cms === 'github-pages' ? repoOwner : '',
      repoName: cms === 'github-pages' ? repoName : '',
      branch: cms === 'github-pages' ? branch : '',
      blogPath: cms === 'github-pages' ? blogPath : '',
      githubToken: cms === 'github-pages' ? await encryptSecret(githubTokenPlain, env.SESSION_SECRET) : '',
      imageGeneration: cms === 'github-pages' ? 'flux' : 'off',
      niche: learned.niche,
      brandVoice: learned.brandVoice,
      brandVoiceOverride,
      autoPublish: false,
      requireApproval,
      keywordSource,
      gsc: null,
      manualKeywords: Array.isArray(body.manualKeywords) ? body.manualKeywords.slice(0, 50) : [],
      llmProvider,
      anthropicApiKey: anthropicKeyPlain ? await encryptSecret(anthropicKeyPlain, env.SESSION_SECRET) : '',
      status: 'active',
      createdAt: nowIso(),
    };
    await saveSite(env, site);
    await addSiteToOwner(env, email, id);
    await audit(env, id, 'site.connected', { url: siteUrl, learnedChars: learned.brandVoice.length });

    // Kick off keyword research immediately so the customer sees data on first dashboard load.
    try { await researchAndStoreKeywords(env, site); }
    catch (err) { await audit(env, id, 'keywords.error', { error: String(err) }); }

    return json({ ok: true, site: stripSiteSecrets(site) });
  }

  // Per-site routes
  const siteMatch = path.match(/^\/api\/sites\/([a-z0-9-]+)(?:\/(.+))?$/i);
  if (siteMatch) {
    const siteId = siteMatch[1];
    const sub = siteMatch[2] || '';
    const site = await getSite(env, siteId, email);
    if (!site) return json({ error: 'not found' }, 404);

    if (sub === '' && request.method === 'DELETE') {
      await env.SITES.delete(`site:${siteId}`);
      await removeSiteFromOwner(env, email, siteId);
      await env.KEYWORDS.delete(`kws:${siteId}`);
      return json({ ok: true });
    }

    if (sub === '' && request.method === 'PATCH') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      // Only specific fields are editable. Credentials and ownership are
      // immutable through this endpoint by design.
      if (typeof body.brandVoiceOverride === 'string') {
        site.brandVoiceOverride = body.brandVoiceOverride.trim().slice(0, 4000);
      }
      if (typeof body.requireApproval === 'boolean') site.requireApproval = body.requireApproval;
      if (typeof body.autoPublish === 'boolean') {
        // Honor the lock — can't flip autoPublish on while requireApproval is true.
        site.autoPublish = site.requireApproval ? false : body.autoPublish;
      }
      if (['gsc', 'ahrefs', 'manual'].includes(body.keywordSource)) site.keywordSource = body.keywordSource;
      if (Array.isArray(body.manualKeywords)) site.manualKeywords = body.manualKeywords.slice(0, 50);
      if (['workers-ai', 'anthropic'].includes(body.llmProvider)) site.llmProvider = body.llmProvider;
      // Set anthropicApiKey ONLY if a non-empty string is provided; pass an
      // empty string to clear it (e.g., when the customer wants to revoke).
      if (typeof body.anthropicApiKey === 'string') {
        const trimmed = body.anthropicApiKey.trim();
        site.anthropicApiKey = trimmed ? await encryptSecret(trimmed, env.SESSION_SECRET) : '';
      }
      // If the customer clears their Anthropic key but llmProvider is still
      // 'anthropic', downgrade them to workers-ai so generation doesn't break.
      if (site.llmProvider === 'anthropic' && !site.anthropicApiKey) site.llmProvider = 'workers-ai';
      // GitHub Pages publishing config — only meaningful when cms is github-pages.
      // Repo/branch/path are public values; the PAT is the only secret.
      if (site.cms === 'github-pages') {
        if (typeof body.repoOwner === 'string') site.repoOwner = body.repoOwner.trim();
        if (typeof body.repoName === 'string') site.repoName = body.repoName.trim();
        if (typeof body.branch === 'string') site.branch = body.branch.trim() || 'main';
        if (typeof body.blogPath === 'string') site.blogPath = (body.blogPath.trim() || 'blog').replace(/^\/+|\/+$/g, '');
        if (typeof body.githubToken === 'string') {
          const trimmed = body.githubToken.trim();
          site.githubToken = trimmed ? await encryptSecret(trimmed, env.SESSION_SECRET) : '';
        }
        if (['flux', 'off'].includes(body.imageGeneration)) site.imageGeneration = body.imageGeneration;
      }
      await saveSite(env, site);
      await audit(env, siteId, 'site.updated', {
        requireApproval: site.requireApproval,
        autoPublish: site.autoPublish,
        keywordSource: site.keywordSource,
        llmProvider: site.llmProvider,
        hasAnthropicKey: Boolean(site.anthropicApiKey),
        hasGithubToken: Boolean(site.githubToken),
        brandVoiceOverrideLen: (site.brandVoiceOverride || '').length,
      });
      return json({ ok: true, site: stripSiteSecrets(site) });
    }

    if (sub === 'research' && request.method === 'POST') {
      const result = await researchAndStoreKeywords(env, site);
      return json({ ok: true, count: result.list.length, keywords: result.list, source: result.source });
    }

    if (sub === 'gsc/properties' && request.method === 'GET') {
      if (!site.gsc || !site.gsc.refreshToken) return json({ error: 'GSC not connected for this site' }, 400);
      try {
        const properties = await listGscProperties(env, site);
        return json({ properties });
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    if (sub === 'gsc/property' && request.method === 'PATCH') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!site.gsc) return json({ error: 'GSC not connected' }, 400);
      const property = (body.property || '').toString().trim();
      if (!property) return json({ error: 'property is required' }, 400);
      site.gsc.property = property;
      await saveSite(env, site);
      await audit(env, siteId, 'gsc.property.set', { property });
      return json({ ok: true, site: stripSiteSecrets(site) });
    }

    if (sub === 'gsc' && request.method === 'DELETE') {
      site.gsc = null;
      await saveSite(env, site);
      await audit(env, siteId, 'gsc.disconnected', {});
      return json({ ok: true, site: stripSiteSecrets(site) });
    }

    if (sub === 'keywords' && request.method === 'GET') {
      const raw = await env.KEYWORDS.get(`kws:${siteId}`);
      return json({ keywords: raw ? JSON.parse(raw) : [] });
    }

    if (sub === 'generate' && request.method === 'POST') {
      // Long-running — Cloudflare gives us ~30s of CPU/IO per request which
      // is enough for one LLM call. If we need more, we'd offload to a
      // queue + websocket; not in Phase 1.
      const result = await runPipeline(env, site, { manual: true });
      return result.ok ? json({ ok: true, article: result.article }) : json({ ok: false, error: result.error }, 500);
    }

    if (sub === 'articles' && request.method === 'GET') {
      const indexRaw = await env.ARTICLES.get(`list:${siteId}`);
      const ids = indexRaw ? JSON.parse(indexRaw) : [];
      const items = await Promise.all(ids.slice(0, 50).map(async (id) => {
        const raw = await env.ARTICLES.get(`art:${siteId}:${id}`);
        if (!raw) return null;
        const a = JSON.parse(raw);
        // Strip the heavy html body from the list response.
        const { html, ...summary } = a;
        return summary;
      }));
      return json({ articles: items.filter(Boolean) });
    }

    const articleMatch = sub.match(/^articles\/([a-z0-9-]+)$/i);
    if (articleMatch && request.method === 'GET') {
      const raw = await env.ARTICLES.get(`art:${siteId}:${articleMatch[1]}`);
      if (!raw) return json({ error: 'not found' }, 404);
      return json({ article: JSON.parse(raw) });
    }
  }

  return json({ error: 'not found' }, 404);
}

// ──────────────────────────────────────────────────────────────
// HTML

function verifyErrorHTML(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sign-in error — Phoenix AI</title>
<style>body{font-family:system-ui,sans-serif;background:#07070D;color:#F0EDE6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{background:#131320;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:420px;text-align:center}h1{color:#FF8C00;margin:0 0 12px}p{color:#A8A49C;margin:0 0 18px}a{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#FF4D00,#FF8C00);color:#fff;border-radius:8px;text-decoration:none;font-weight:700}</style>
</head><body><div class="card"><h1>Sign-in link not valid</h1><p>${msg}</p><a href="https://phoenixmethodseo.com/phoenix-ai/#signup">Get a new link</a></div></body></html>`;
}

function dashboardHTML() {
  // Server-rendered shell. JS fetches /api/me and renders the rest client-side.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phoenix AI Dashboard</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/x-icon" href="https://phoenixmethodseo.com/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Rajdhani:wght@500;700&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#07070D; --surface:#0E0E18; --card:#131320; --border:rgba(255,255,255,0.08); --text:#F0EDE6; --muted:#A8A49C; --deep:#6B6860; --fire-s:#FF4D00; --fire-m:#FF8C00; --fire-e:#FFB800; --danger:#ff7373; }
  * { box-sizing: border-box; margin: 0; padding: 0; min-width: 0; }
  body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; overflow-wrap: break-word; word-wrap: break-word; }
  a { color: var(--fire-m); text-decoration: none; }
  a:hover { color: var(--fire-e); }
  header.topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .brand { font-family: 'Cinzel', serif; font-weight: 900; font-size: 1.2rem; letter-spacing: 0.04em; background: linear-gradient(135deg, var(--fire-s), var(--fire-m), var(--fire-e)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .topbar-right { display: flex; align-items: center; gap: 16px; }
  .topbar-right .email { color: var(--muted); font-size: 0.88rem; }
  .topbar-right a.logout { font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; letter-spacing: 0.15em; text-transform: uppercase; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-family: 'Cinzel', serif; font-weight: 700; font-size: 1.8rem; margin-bottom: 6px; }
  h2 { font-family: 'Cinzel', serif; font-weight: 700; font-size: 1.25rem; margin: 32px 0 14px; }
  h3 { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
  .lede { color: var(--muted); margin-bottom: 24px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; margin-bottom: 20px; overflow: hidden; overflow-wrap: break-word; word-wrap: break-word; }
  .panel.empty { text-align: center; padding: 40px 24px; }
  .panel.empty h2 { margin-top: 0; }
  .panel h2, .panel h3, .panel p, .panel a, .panel label, .panel pre, .panel summary { overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; max-width: 100%; }
  .panel table { width: 100%; table-layout: auto; }
  .panel table td { overflow-wrap: break-word; word-break: break-word; max-width: 0; }
  .panel pre, .panel code { white-space: pre-wrap; word-break: break-all; }
  .panel .site-meta { word-break: break-word; }
  .row-actions { flex-wrap: wrap; }
  textarea, input[type=text], input[type=url], input[type=password], input[type=email] { max-width: 100%; }
  .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.88rem; letter-spacing: 0.1em; text-transform: uppercase; border: none; cursor: pointer; transition: transform .15s, box-shadow .2s; }
  .btn-primary { background: linear-gradient(135deg, var(--fire-s), var(--fire-m)); color: #fff; }
  .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(255,140,0,0.25); }
  .btn-ghost { background: transparent; color: var(--fire-m); border: 1px solid var(--fire-m); }
  .btn-ghost:hover { background: rgba(255,140,0,0.08); }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  form.connect { display: grid; gap: 14px; max-width: 560px; }
  label { font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  input[type=text], input[type=url], input[type=password] { width: 100%; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: 'Outfit', sans-serif; font-size: 0.95rem; }
  input:focus { outline: none; border-color: var(--fire-m); }
  .help { color: var(--deep); font-size: 0.82rem; }
  .help a { color: var(--muted); text-decoration: underline; }
  .row-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; }
  .badge.draft { background: rgba(255,140,0,0.15); color: var(--fire-m); border: 1px solid rgba(255,140,0,0.3); }
  .badge.publish { background: rgba(120,220,140,0.12); color: #7fd693; border: 1px solid rgba(120,220,140,0.3); }
  .badge.ready { background: rgba(120,180,255,0.12); color: #91baff; border: 1px solid rgba(120,180,255,0.3); }
  .badge.failed { background: rgba(255,77,77,0.12); color: var(--danger); border: 1px solid rgba(255,77,77,0.3); }
  button.link-like { background: none; border: none; color: var(--fire-m); cursor: pointer; padding: 0; font: inherit; font-size: 0.92rem; }
  button.link-like:hover { color: var(--fire-e); text-decoration: underline; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 100; }
  .modal-overlay.show { display: flex; }
  .modal { background: var(--card); border: 1px solid var(--border); border-radius: 14px; max-width: 900px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; }
  .modal-head { padding: 18px 22px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .modal-head h2 { margin: 0; font-size: 1.15rem; font-family: 'Cinzel', serif; }
  .modal-head button.close { background: none; border: none; color: var(--muted); font-size: 1.6rem; cursor: pointer; padding: 0; line-height: 1; }
  .modal-tabs { display: flex; gap: 6px; padding: 12px 22px 0; border-bottom: 1px solid var(--border); }
  .modal-tab { background: none; border: none; padding: 8px 14px; color: var(--muted); cursor: pointer; font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 2px solid transparent; }
  .modal-tab.active { color: var(--fire-m); border-bottom-color: var(--fire-m); }
  .modal-body { padding: 22px; overflow-y: auto; flex: 1; }
  .modal-pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.85rem; color: var(--text); max-height: 60vh; overflow-y: auto; }
  .modal-foot { padding: 14px 22px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .modal-meta { color: var(--muted); font-size: 0.85rem; }
  .article-render { font-family: 'Outfit', sans-serif; line-height: 1.7; color: var(--text); }
  .article-render h2, .article-render h3 { font-family: 'Cinzel', serif; margin: 18px 0 10px; }
  .article-render p { margin-bottom: 12px; color: var(--text); }
  .article-render a { color: var(--fire-m); }
  .site-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .site-meta { font-size: 0.88rem; color: var(--muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.92rem; }
  table th, table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  table th { font-family: 'Rajdhani', sans-serif; font-size: 0.74rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--deep); font-weight: 600; }
  table tr:last-child td { border-bottom: none; }
  .keyword-chip { display: inline-block; padding: 4px 10px; margin: 3px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; font-size: 0.82rem; }
  .keyword-chip.picked { opacity: 0.5; text-decoration: line-through; }
  .status-banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 14px; font-size: 0.92rem; display: none; }
  .status-banner.show { display: block; }
  .status-banner.success { background: rgba(120,220,140,0.08); border: 1px solid rgba(120,220,140,0.3); color: #b3edc1; }
  .status-banner.error { background: rgba(255,77,77,0.08); border: 1px solid rgba(255,77,77,0.3); color: var(--danger); }
  .status-banner.info { background: rgba(255,184,0,0.06); border: 1px solid rgba(255,184,0,0.25); color: var(--fire-m); }
  .loader { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,140,0,0.3); border-top-color: var(--fire-m); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .trial-banner { background: linear-gradient(135deg, rgba(255,77,0,0.1), rgba(255,184,0,0.05)); border: 1px solid rgba(255,140,0,0.25); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; font-size: 0.92rem; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">PHOENIX AI</div>
    <div class="topbar-right">
      <span class="email" id="topbarEmail">—</span>
      <a class="logout" href="/auth/logout">Log out</a>
    </div>
  </header>
  <main>
    <div id="trialBanner" class="trial-banner" style="display:none;"></div>
    <div id="statusBanner" class="status-banner"></div>
    <div id="root">
      <p class="lede"><span class="loader"></span> Loading your dashboard…</p>
    </div>
  </main>

  <div class="modal-overlay" id="articleModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal">
      <div class="modal-head">
        <h2 id="modalTitle">Article</h2>
        <button class="close" id="modalClose" aria-label="Close">&times;</button>
      </div>
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="preview">Preview</button>
        <button class="modal-tab" data-tab="html">HTML</button>
        <button class="modal-tab" data-tab="meta">Meta &amp; FAQ</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-foot">
        <span class="modal-meta" id="modalMeta"></span>
        <button class="btn btn-primary" id="modalCopyBtn">Copy HTML</button>
      </div>
    </div>
  </div>

  <template id="emptyTemplate">
    <div class="panel empty">
      <h2>Connect Your First Site</h2>
      <p class="lede">Phoenix AI needs to know where to publish. Connect a WordPress site and we'll start researching keywords for it immediately.</p>
      <div id="connectFormSlot"></div>
    </div>
  </template>

  <template id="connectFormTemplate">
    <form class="connect" id="connectForm">
      <div>
        <label>How will Phoenix AI publish?</label>
        <div style="display:grid;gap:8px;margin-top:6px;">
          <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">
            <input type="radio" name="cms" value="wordpress" checked style="margin-top:4px;">
            <span><strong>WordPress (autopilot)</strong><br><span style="color:var(--muted);font-size:0.85rem;">Articles are pushed as drafts (or live, if you allow) directly to your WP blog.</span></span>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">
            <input type="radio" name="cms" value="github-pages" style="margin-top:4px;">
            <span><strong>GitHub Pages (autopilot)</strong><br><span style="color:var(--muted);font-size:0.85rem;">For sites built with Jekyll / Hugo / 11ty / Astro / plain HTML hosted on GitHub Pages. Phoenix AI commits articles directly to your repo and your site auto-rebuilds.</span></span>
          </label>
          <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">
            <input type="radio" name="cms" value="manual" style="margin-top:4px;">
            <span><strong>Manual paste (any CMS)</strong><br><span style="color:var(--muted);font-size:0.85rem;">Phoenix AI does the keyword research and writing. You copy the HTML into Squarespace / Wix / Ghost / wherever. For sites without a WordPress endpoint.</span></span>
          </label>
        </div>
      </div>
      <div>
        <label for="siteUrl">Site URL</label>
        <input type="url" id="siteUrl" required placeholder="https://yourblog.com">
      </div>
      <div data-cms-fields="wordpress">
        <label for="appUsername">WordPress username</label>
        <input type="text" id="appUsername" placeholder="your-wp-login">
      </div>
      <div data-cms-fields="wordpress">
        <label for="appPassword">Application password</label>
        <input type="password" id="appPassword" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx">
        <p class="help" style="margin-top:6px;">Generate one at <em>WP Admin → Users → Profile → Application Passwords</em>. We store it encrypted; it never leaves the worker except to publish posts on your behalf. <a href="https://wordpress.org/documentation/article/application-passwords/" target="_blank" rel="noopener">Help</a></p>
      </div>
      <div data-cms-fields="github-pages" style="display:none;">
        <label for="repoOwner">GitHub repo owner / org</label>
        <input type="text" id="repoOwner" placeholder="KandyPhoenix">
      </div>
      <div data-cms-fields="github-pages" style="display:none;">
        <label for="repoName">GitHub repo name</label>
        <input type="text" id="repoName" placeholder="my-website">
      </div>
      <div data-cms-fields="github-pages" style="display:none;display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div>
          <label for="branch">Branch</label>
          <input type="text" id="branch" value="main" placeholder="main">
        </div>
        <div>
          <label for="blogPath">Blog folder</label>
          <input type="text" id="blogPath" value="blog" placeholder="blog">
        </div>
      </div>
      <div data-cms-fields="github-pages" style="display:none;">
        <label for="githubToken">GitHub fine-grained PAT</label>
        <input type="password" id="githubToken" placeholder="github_pat_…">
        <p class="help" style="margin-top:6px;">Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> — scope it to the single repo you typed above with <strong>Contents: read &amp; write</strong>. We store it encrypted; it never leaves the worker except to commit posts.</p>
      </div>
      <details style="margin-top:4px;">
        <summary style="cursor:pointer;color:var(--muted);font-family:'Rajdhani',sans-serif;font-size:0.82rem;letter-spacing:0.1em;text-transform:uppercase;">Advanced (optional)</summary>
        <div style="margin-top:14px;display:grid;gap:14px;">
          <div>
            <label for="brandVoiceOverride">Brand voice override</label>
            <textarea id="brandVoiceOverride" rows="5" placeholder="Optional. Paste 200–500 words that capture how the site should sound. If empty, Phoenix AI learns the voice from the homepage." style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Outfit',sans-serif;font-size:0.95rem;resize:vertical;"></textarea>
            <p class="help" style="margin-top:6px;">Use this when the homepage doesn't represent the voice you want — thin content, placeholder copy, or a regulated industry where you want full control.</p>
          </div>
          <div>
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">
              <input type="checkbox" id="requireApproval" style="margin-top:4px;">
              <span><strong>Require approval on every article</strong><br><span style="color:var(--muted);font-size:0.85rem;">Recommended for healthcare, finance, legal, or any YMYL site. Locks Phoenix AI to draft-only — you'll review every article in WordPress before it goes live.</span></span>
            </label>
          </div>
        </div>
      </details>
      <div class="row-actions">
        <button type="submit" class="btn btn-primary" id="connectBtn">Connect Site</button>
      </div>
    </form>
  </template>

  <script>
    const root = document.getElementById('root');
    const banner = document.getElementById('statusBanner');
    const trialBanner = document.getElementById('trialBanner');
    const topbarEmail = document.getElementById('topbarEmail');

    function showBanner(msg, kind) { banner.textContent = msg; banner.className = 'status-banner show ' + kind; setTimeout(() => banner.classList.remove('show'), 8000); }

    function escapeHTML(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

    async function api(method, path, body) {
      const opts = { method, credentials: 'include', headers: {} };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const res = await fetch(path, opts);
      if (res.status === 401) { window.location.href = '/'; throw new Error('unauthorized'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    function renderTrial(customer) {
      if (!customer.trialEnds) return;
      const ms = new Date(customer.trialEnds).getTime() - Date.now();
      if (ms <= 0) {
        trialBanner.innerHTML = '<strong>Your trial has ended.</strong> Pick a plan to keep generating articles — billing isn\\'t live yet in this beta, contact <a href="mailto:hello@phoenixmethodseo.com">hello@phoenixmethodseo.com</a> to extend.';
        trialBanner.style.display = 'block';
      } else if (customer.plan === 'trial') {
        const days = Math.ceil(ms / 86400000);
        trialBanner.innerHTML = '<strong>' + days + ' day' + (days === 1 ? '' : 's') + ' left in your free trial.</strong> Generate as much as you want — no card required.';
        trialBanner.style.display = 'block';
      }
    }

    function attachConnectForm(formEl) {
      const btn = formEl.querySelector('#connectBtn');
      const cmsRadios = formEl.querySelectorAll('input[name=cms]');
      function syncCmsFields() {
        const cms = formEl.querySelector('input[name=cms]:checked').value;
        ['wordpress', 'github-pages'].forEach((kind) => {
          formEl.querySelectorAll('[data-cms-fields="' + kind + '"]').forEach((el) => {
            el.style.display = cms === kind ? '' : 'none';
          });
        });
      }
      cmsRadios.forEach(r => r.addEventListener('change', syncCmsFields));
      syncCmsFields();
      formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true; btn.innerHTML = '<span class="loader"></span>Connecting…';
        try {
          const cms = formEl.querySelector('input[name=cms]:checked').value;
          const url = formEl.querySelector('#siteUrl').value.trim();
          const brandVoiceOverride = (formEl.querySelector('#brandVoiceOverride').value || '').trim();
          const requireApproval = formEl.querySelector('#requireApproval').checked;
          const payload = { url, cms, brandVoiceOverride, requireApproval };
          if (cms === 'wordpress') {
            payload.appUsername = formEl.querySelector('#appUsername').value.trim();
            payload.appPassword = formEl.querySelector('#appPassword').value.trim();
          } else if (cms === 'github-pages') {
            payload.repoOwner = formEl.querySelector('#repoOwner').value.trim();
            payload.repoName = formEl.querySelector('#repoName').value.trim();
            payload.branch = formEl.querySelector('#branch').value.trim() || 'main';
            payload.blogPath = formEl.querySelector('#blogPath').value.trim() || 'blog';
            payload.githubToken = formEl.querySelector('#githubToken').value.trim();
          }
          await api('POST', '/api/sites', payload);
          showBanner('Site connected. Researching keywords now…', 'success');
          await load();
        } catch (err) {
          showBanner(err.message, 'error');
        } finally {
          btn.disabled = false; btn.textContent = 'Connect Site';
        }
      });
    }

    function renderSite(site, keywords, articles) {
      const articleRows = articles.length ? articles.map(a => {
        const link = a.publicUrl ? a.publicUrl : (a.wpEditUrl || '');
        const viewBtn = '<button class="link-like" data-action="view-article" data-site="' + site.id + '" data-article="' + a.id + '">View / copy</button>';
        const openLink = link ? ' &middot; <a href="' + link + '" target="_blank" rel="noopener">Open ↗</a>' : '';
        const badgeClass = a.status === 'publish' ? 'publish' : a.status === 'failed' ? 'failed' : a.status === 'ready' ? 'ready' : 'draft';
        return '<tr>' +
          '<td>' + escapeHTML(a.title || '—') + '<div style="color:var(--deep);font-size:0.82rem;margin-top:2px;">' + escapeHTML(a.keyword || '') + '</div></td>' +
          '<td><span class="badge ' + badgeClass + '">' + escapeHTML(a.status || 'draft') + '</span></td>' +
          '<td>' + escapeHTML(formatDate(a.generatedAt)) + '</td>' +
          '<td>' + viewBtn + openLink + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="4" style="color:var(--deep);text-align:center;padding:24px;">No articles yet. Click <em>Generate Article Now</em> above to create your first.</td></tr>';

      const keywordChips = keywords.length ? keywords.slice(0, 20).map(k =>
        '<span class="keyword-chip' + (k.picked ? ' picked' : '') + '" title="vol ' + k.volume + ' / KD ' + k.kd + ' / ' + escapeHTML(k.intent) + '">' + escapeHTML(k.keyword) + '</span>'
      ).join('') : '<span style="color:var(--deep);">No keywords yet. Click <em>Refresh keywords</em>.</span>';

      const approvalBadge = site.requireApproval
        ? '<span class="badge draft" style="margin-left:10px;vertical-align:middle;">Approval required</span>' : '';
      const voiceOverrideLen = (site.brandVoiceOverride || '').length;
      const keywordSource = site.keywordSource || 'gsc';
      const gscConnected = site.gsc && site.gsc.connected;
      const gscPropertySet = gscConnected && site.gsc.property;

      // Banner shown above the keyword queue when GSC needs attention.
      let keywordSourceBanner = '';
      if (keywordSource === 'gsc' && !gscConnected) {
        keywordSourceBanner = '<div class="status-banner show info" style="margin:14px 0;">Keyword source is set to Google Search Console, but no GSC account is connected yet. <button class="link-like" data-action="gsc-connect" data-site="' + site.id + '">Connect GSC →</button></div>';
      } else if (keywordSource === 'gsc' && gscConnected && !gscPropertySet) {
        keywordSourceBanner = '<div class="status-banner show info" style="margin:14px 0;">GSC connected, but no property selected. <button class="link-like" data-action="gsc-pick" data-site="' + site.id + '">Pick a property →</button></div>';
      }

      return '<div class="panel">' +
        '<div class="site-header">' +
          '<div><h2 style="margin:0;display:inline;">' + escapeHTML(site.url) + '</h2>' + approvalBadge +
          '<div class="site-meta">' + (site.niche ? escapeHTML(site.niche.slice(0, 140)) : '<em>Niche learning…</em>') + '</div></div>' +
          '<div class="row-actions">' +
            '<button class="btn btn-primary" data-action="generate" data-site="' + site.id + '">Generate Article Now</button>' +
            '<button class="btn btn-ghost" data-action="research" data-site="' + site.id + '">Refresh keywords</button>' +
            (gscConnected
              ? '<button class="btn btn-ghost" data-action="gsc-disconnect" data-site="' + site.id + '">Disconnect GSC</button>'
              : '<button class="btn btn-ghost" data-action="gsc-connect" data-site="' + site.id + '">Connect GSC</button>') +
            '<button class="btn btn-danger" data-action="disconnect" data-site="' + site.id + '">Disconnect</button>' +
          '</div>' +
        '</div>' +
        keywordSourceBanner +
        '<details style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">' +
          '<summary style="cursor:pointer;color:var(--muted);font-family:\\'Rajdhani\\',sans-serif;font-size:0.82rem;letter-spacing:0.1em;text-transform:uppercase;">Settings</summary>' +
          '<form data-settings-site="' + site.id + '" style="display:grid;gap:14px;margin-top:14px;max-width:640px;">' +
            '<div>' +
              '<label>Brand voice override</label>' +
              '<textarea name="brandVoiceOverride" rows="5" placeholder="Optional. Paste 200–500 words that capture the voice." style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;resize:vertical;">' + escapeHTML(site.brandVoiceOverride || '') + '</textarea>' +
              '<p class="help" style="margin-top:6px;">' + (voiceOverrideLen ? voiceOverrideLen + ' chars — overriding the auto-crawled voice.' : 'Empty — using the auto-crawled homepage as the voice sample.') + '</p>' +
            '</div>' +
            '<div>' +
              '<label>Keyword source</label>' +
              '<div style="display:grid;gap:8px;margin-top:8px;">' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="keywordSource" value="gsc"' + (keywordSource === 'gsc' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Google Search Console</strong> <span class="badge publish" style="font-size:0.62rem;">Recommended</span><br><span style="color:var(--muted);font-size:0.85rem;">Free. Pulls "low-hanging fruit" queries the site already ranks position 5–20 for.</span></span>' +
                '</label>' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="keywordSource" value="ahrefs"' + (keywordSource === 'ahrefs' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Ahrefs</strong><br><span style="color:var(--muted);font-size:0.85rem;">Discovers brand-new keywords for sites with no traffic yet. Requires AHREFS_API_KEY on the worker.</span></span>' +
                '</label>' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="keywordSource" value="manual"' + (keywordSource === 'manual' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Manual paste</strong><br><span style="color:var(--muted);font-size:0.85rem;">You paste 10–30 starter keywords below. Best for brand-new sites with no GSC data.</span></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
            '<div data-keyword-source-fields="manual" style="display:' + (keywordSource === 'manual' ? 'block' : 'none') + ';">' +
              '<label>Manual keyword list (one per line)</label>' +
              '<textarea name="manualKeywords" rows="6" placeholder="one keyword per line: best dental clinic seattle, teeth whitening cost, pediatric dentist near me" style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;resize:vertical;">' + escapeHTML((site.manualKeywords || []).map(k => typeof k === 'string' ? k : k.keyword).join('\\n')) + '</textarea>' +
            '</div>' +
            '<div>' +
              '<label>AI provider</label>' +
              '<div style="display:grid;gap:8px;margin-top:8px;">' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="llmProvider" value="workers-ai"' + ((site.llmProvider || 'workers-ai') === 'workers-ai' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Cloudflare Workers AI (Llama 3.3 70B)</strong> <span class="badge publish" style="font-size:0.62rem;">Default · Free</span><br><span style="color:var(--muted);font-size:0.85rem;">Runs on Cloudflare\\'s infra. Included free up to ~10 articles/day, then sub-cent per article.</span></span>' +
                '</label>' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="llmProvider" value="anthropic"' + (site.llmProvider === 'anthropic' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Anthropic Claude (BYOK)</strong> <span class="badge draft" style="font-size:0.62rem;">Premium</span><br><span style="color:var(--muted);font-size:0.85rem;">Higher-quality brand-voice matching. <em>You</em> pay your own Anthropic bill — paste your API key below.</span></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
            '<div data-llm-provider-fields="anthropic" style="display:' + (site.llmProvider === 'anthropic' ? 'block' : 'none') + ';">' +
              '<label>Anthropic API key</label>' +
              '<input type="password" name="anthropicApiKey" placeholder="' + (site.hasAnthropicKey ? '••• key already set — paste to replace, leave blank to keep' : 'sk-ant-…') + '" style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;">' +
              '<p class="help" style="margin-top:6px;">Get one at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>. We store it encrypted and only use it for this site.</p>' +
            '</div>' +
            (site.cms === 'github-pages' ? (
              '<div>' +
                '<label>GitHub Pages publishing</label>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">' +
                  '<div><label style="font-size:0.7rem;">Repo owner</label><input type="text" name="repoOwner" value="' + escapeHTML(site.repoOwner || '') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
                  '<div><label style="font-size:0.7rem;">Repo name</label><input type="text" name="repoName" value="' + escapeHTML(site.repoName || '') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
                  '<div><label style="font-size:0.7rem;">Branch</label><input type="text" name="branch" value="' + escapeHTML(site.branch || 'main') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
                  '<div><label style="font-size:0.7rem;">Blog folder</label><input type="text" name="blogPath" value="' + escapeHTML(site.blogPath || 'blog') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
                '</div>' +
                '<label style="font-size:0.7rem;margin-top:10px;">GitHub fine-grained PAT</label>' +
                '<input type="password" name="githubToken" placeholder="' + (site.hasGithubToken ? '••• token already set — paste to replace, leave blank to keep' : 'github_pat_…') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);">' +
                '<p class="help" style="margin-top:6px;">Scope: Contents: read &amp; write on the single repo above. Created at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</p>' +
                '<label style="font-size:0.7rem;margin-top:14px;">Hero image generation</label>' +
                '<div style="display:grid;gap:6px;margin-top:6px;">' +
                  '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--text);"><input type="radio" name="imageGeneration" value="flux"' + ((site.imageGeneration || 'flux') === 'flux' ? ' checked' : '') + '> FLUX.1 schnell — AI-generated editorial illustration per article (free via Workers AI, ~5-10s)</label>' +
                  '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--text);"><input type="radio" name="imageGeneration" value="off"' + (site.imageGeneration === 'off' ? ' checked' : '') + '> Off — no hero image</label>' +
                '</div>' +
              '</div>'
            ) : '') +
            '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
              '<input type="checkbox" name="requireApproval"' + (site.requireApproval ? ' checked' : '') + ' style="margin-top:4px;">' +
              '<span><strong>Require approval on every article</strong><br><span style="color:var(--muted);font-size:0.85rem;">Locks this site to draft-only. Recommended for YMYL clients.</span></span>' +
            '</label>' +
            '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:' + (site.requireApproval ? 'var(--deep)' : 'var(--text)') + ';">' +
              '<input type="checkbox" name="autoPublish"' + (site.autoPublish ? ' checked' : '') + (site.requireApproval ? ' disabled' : '') + ' style="margin-top:4px;">' +
              '<span><strong>Auto-publish</strong><br><span style="color:var(--muted);font-size:0.85rem;">Publish directly (skip draft). ' + (site.requireApproval ? 'Disabled while approval is required.' : 'Off by default.') + '</span></span>' +
            '</label>' +
            '<div class="row-actions"><button type="submit" class="btn btn-ghost">Save settings</button></div>' +
          '</form>' +
        '</details>' +
        '<h3 style="margin-top:24px;">Keyword Queue</h3>' +
        '<div>' + keywordChips + '</div>' +
        '<h3 style="margin-top:24px;">Articles</h3>' +
        '<table><thead><tr><th>Title / target keyword</th><th>Status</th><th>Generated</th><th></th></tr></thead><tbody>' + articleRows + '</tbody></table>' +
      '</div>';
    }

    async function load() {
      try {
        const me = await api('GET', '/api/me');
        topbarEmail.textContent = me.customer.email;
        renderTrial(me.customer);

        if (!me.sites.length) {
          root.innerHTML = '';
          const empty = document.getElementById('emptyTemplate').content.cloneNode(true);
          root.appendChild(empty);
          const form = document.getElementById('connectFormTemplate').content.cloneNode(true);
          document.getElementById('connectFormSlot').appendChild(form);
          attachConnectForm(document.getElementById('connectForm'));
          return;
        }

        // For each site, fetch keywords + articles in parallel.
        const details = await Promise.all(me.sites.map(async (s) => {
          const [k, a] = await Promise.all([
            api('GET', '/api/sites/' + s.id + '/keywords'),
            api('GET', '/api/sites/' + s.id + '/articles'),
          ]);
          return { site: s, keywords: k.keywords || [], articles: a.articles || [] };
        }));

        const sitesHtml = details.map(d => renderSite(d.site, d.keywords, d.articles)).join('');
        root.innerHTML = '<h1>Your Sites</h1><p class="lede">Manage your connected sites, refresh keyword research, and ship articles.</p>' +
          sitesHtml +
          '<div class="panel"><h3 style="margin-top:0;">Connect Another Site</h3><div id="connectFormSlot"></div></div>';

        const form = document.getElementById('connectFormTemplate').content.cloneNode(true);
        document.getElementById('connectFormSlot').appendChild(form);
        attachConnectForm(document.getElementById('connectForm'));

        root.addEventListener('click', onAction, { once: false });
        root.querySelectorAll('form[data-settings-site]').forEach(attachSettingsForm);
      } catch (err) {
        root.innerHTML = '<div class="panel"><h2>Couldn\\'t load your dashboard</h2><p class="lede">' + escapeHTML(err.message) + '</p><a class="btn btn-primary" href="/">Reload</a></div>';
      }
    }

    function attachSettingsForm(form) {
      // Show/hide manual-keywords textarea when source toggles
      form.querySelectorAll('input[name=keywordSource]').forEach((r) => {
        r.addEventListener('change', () => {
          const manualField = form.querySelector('[data-keyword-source-fields=manual]');
          if (manualField) manualField.style.display = r.checked && r.value === 'manual' ? 'block' : 'none';
        });
      });
      // Show/hide Anthropic key field when provider toggles
      form.querySelectorAll('input[name=llmProvider]').forEach((r) => {
        r.addEventListener('change', () => {
          const keyField = form.querySelector('[data-llm-provider-fields=anthropic]');
          if (keyField) keyField.style.display = r.checked && r.value === 'anthropic' ? 'block' : 'none';
        });
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const siteId = form.dataset.settingsSite;
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.innerHTML = '<span class="loader"></span>Saving…';
        try {
          const sourceRadio = form.querySelector('input[name=keywordSource]:checked');
          const providerRadio = form.querySelector('input[name=llmProvider]:checked');
          const manualText = (form.querySelector('textarea[name=manualKeywords]') || {}).value || '';
          const manualKeywords = manualText.split(/\\n+/).map(s => s.trim()).filter(Boolean).slice(0, 50);
          // Only send anthropicApiKey if the field has content. Empty string
          // means "keep what's stored" — don't accidentally clear it.
          const keyField = form.querySelector('input[name=anthropicApiKey]');
          const keyValue = keyField ? keyField.value.trim() : '';
          const patch = {
            brandVoiceOverride: form.querySelector('textarea[name=brandVoiceOverride]').value,
            requireApproval: form.querySelector('input[name=requireApproval]').checked,
            autoPublish: form.querySelector('input[name=autoPublish]').checked,
            keywordSource: sourceRadio ? sourceRadio.value : undefined,
            llmProvider: providerRadio ? providerRadio.value : undefined,
            manualKeywords,
          };
          if (keyValue) patch.anthropicApiKey = keyValue;
          // GitHub Pages fields are only present on github-pages sites.
          const repoOwnerEl = form.querySelector('input[name=repoOwner]');
          if (repoOwnerEl) {
            patch.repoOwner = repoOwnerEl.value.trim();
            patch.repoName = form.querySelector('input[name=repoName]').value.trim();
            patch.branch = form.querySelector('input[name=branch]').value.trim();
            patch.blogPath = form.querySelector('input[name=blogPath]').value.trim();
            const ghToken = form.querySelector('input[name=githubToken]').value.trim();
            if (ghToken) patch.githubToken = ghToken;
            const imgRadio = form.querySelector('input[name=imageGeneration]:checked');
            if (imgRadio) patch.imageGeneration = imgRadio.value;
          }
          await api('PATCH', '/api/sites/' + siteId, patch);
          showBanner('Settings saved.', 'success');
          await load();
        } catch (err) {
          showBanner(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Save settings';
        }
      });
    }

    async function pickGscProperty(siteId) {
      try {
        const r = await api('GET', '/api/sites/' + siteId + '/gsc/properties');
        const properties = r.properties || [];
        if (!properties.length) { showBanner('No GSC properties found on that Google account.', 'error'); return; }
        if (properties.length === 1) {
          await api('PATCH', '/api/sites/' + siteId + '/gsc/property', { property: properties[0].siteUrl });
          showBanner('GSC property set: ' + properties[0].siteUrl, 'success');
          await load();
          return;
        }
        const list = properties.map((p, i) => (i + 1) + '. ' + p.siteUrl + ' (' + p.permissionLevel + ')').join('\\n');
        const pick = prompt('Pick the GSC property for this site (enter the number):\\n\\n' + list);
        const idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !properties[idx]) { showBanner('Cancelled.', 'info'); return; }
        await api('PATCH', '/api/sites/' + siteId + '/gsc/property', { property: properties[idx].siteUrl });
        showBanner('GSC property set: ' + properties[idx].siteUrl, 'success');
        await load();
      } catch (err) {
        showBanner(err.message, 'error');
      }
    }

    // ── article modal ──
    const modal = document.getElementById('articleModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const modalMeta = document.getElementById('modalMeta');
    const modalCopyBtn = document.getElementById('modalCopyBtn');
    let currentArticle = null;
    let currentTab = 'preview';
    function renderModalTab() {
      if (!currentArticle) return;
      const a = currentArticle;
      if (currentTab === 'preview') {
        // FAQs come from the structured JSON, not the HTML body. We append
        // them visually here so the customer sees a complete article in the
        // Preview tab — and so older articles that have the FAQ section
        // already inlined (legacy generations) still look fine.
        const faqHtml = (a.faqs && a.faqs.length)
          ? '<h2 style="margin-top:32px;">Frequently Asked Questions</h2>' +
            a.faqs.map(f => '<div style="margin-bottom:18px;"><h3 style="font-family:Outfit,sans-serif;text-transform:none;letter-spacing:0;color:var(--text);font-size:1.05rem;margin-bottom:6px;">' + escapeHTML(f.q) + '</h3><p style="margin:0;">' + escapeHTML(f.a) + '</p></div>').join('')
          : '';
        modalBody.innerHTML = '<div class="article-render"><h1 style="font-family:Cinzel,serif;font-size:1.6rem;margin-bottom:6px;">' + escapeHTML(a.title || '') + '</h1>' + (a.metaDescription ? '<p style="color:var(--muted);margin-bottom:18px;">' + escapeHTML(a.metaDescription) + '</p>' : '') + (a.html || '') + faqHtml + '</div>';
      } else if (currentTab === 'html') {
        // Show the same composed output the customer would copy/paste: body
        // HTML plus the FAQ section rendered from JSON.
        const faqHtmlSrc = (a.faqs && a.faqs.length)
          ? '\\n\\n<h2>Frequently Asked Questions</h2>\\n' +
            a.faqs.map(f => '<h3>' + escapeHTML(f.q) + '</h3>\\n<p>' + escapeHTML(f.a) + '</p>').join('\\n')
          : '';
        modalBody.innerHTML = '<pre class="modal-pre">' + escapeHTML((a.html || '') + faqHtmlSrc) + '</pre>';
      } else if (currentTab === 'meta') {
        const tags = (a.tags || []).map(t => '<span class="keyword-chip">' + escapeHTML(t) + '</span>').join(' ');
        const faqs = (a.faqs || []).map(f => '<div style="margin-bottom:14px;"><strong>' + escapeHTML(f.q) + '</strong><br><span style="color:var(--muted);">' + escapeHTML(f.a) + '</span></div>').join('') || '<span style="color:var(--deep);">No FAQs.</span>';
        modalBody.innerHTML =
          '<h3>Title</h3><p>' + escapeHTML(a.title || '—') + '</p>' +
          '<h3>Slug</h3><p style="font-family:monospace;color:var(--muted);">' + escapeHTML(a.slug || '—') + '</p>' +
          '<h3>Meta description</h3><p>' + escapeHTML(a.metaDescription || '—') + '</p>' +
          '<h3>Target keyword</h3><p>' + escapeHTML(a.keyword || '—') + '</p>' +
          '<h3>Tags</h3><p>' + (tags || '<span style="color:var(--deep);">None.</span>') + '</p>' +
          '<h3>FAQs</h3><div>' + faqs + '</div>';
      }
    }
    document.querySelectorAll('.modal-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(x => x.classList.toggle('active', x === t));
      currentTab = t.dataset.tab;
      renderModalTab();
    }));
    document.getElementById('modalClose').addEventListener('click', () => modal.classList.remove('show'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('show'); });
    modalCopyBtn.addEventListener('click', async () => {
      if (!currentArticle) return;
      try { await navigator.clipboard.writeText(currentArticle.html || ''); modalCopyBtn.textContent = 'Copied!'; setTimeout(() => { modalCopyBtn.textContent = 'Copy HTML'; }, 1500); }
      catch { showBanner('Copy failed — select the HTML tab and copy manually.', 'error'); }
    });
    async function openArticleModal(siteId, articleId) {
      modal.classList.add('show');
      modalBody.innerHTML = '<p class="lede"><span class="loader"></span>Loading article…</p>';
      try {
        const r = await api('GET', '/api/sites/' + siteId + '/articles/' + articleId);
        currentArticle = r.article;
        modalTitle.textContent = currentArticle.title || 'Article';
        modalMeta.textContent = (currentArticle.keyword || '') + ' · ' + formatDate(currentArticle.generatedAt);
        currentTab = 'preview';
        document.querySelectorAll('.modal-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'preview'));
        renderModalTab();
      } catch (err) {
        modalBody.innerHTML = '<p class="lede">' + escapeHTML(err.message) + '</p>';
      }
    }

    async function onAction(e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const siteId = btn.dataset.site;
      if (action === 'view-article') {
        return openArticleModal(siteId, btn.dataset.article);
      }
      if (action === 'gsc-connect') {
        // Full-page redirect to start the OAuth flow on the worker.
        window.location.href = '/auth/google/start?siteId=' + encodeURIComponent(siteId);
        return;
      }
      if (action === 'gsc-pick') {
        return pickGscProperty(siteId);
      }
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.innerHTML = '<span class="loader"></span>' + originalText;
      try {
        if (action === 'generate') {
          const out = await api('POST', '/api/sites/' + siteId + '/generate');
          showBanner('Article generated: "' + (out.article.title || '') + '" — open it from the table below.', 'success');
        } else if (action === 'research') {
          const out = await api('POST', '/api/sites/' + siteId + '/research');
          const isFallback = (out.source || '').endsWith('-seed-fallback');
          if (isFallback) {
            showBanner('Refreshed — ' + out.count + ' seed keywords queued. (Your primary source returned nothing; using niche-derived starters. Add a few manual keywords in Settings for better results.)', 'info');
          } else {
            showBanner('Refreshed — ' + out.count + ' keywords queued (' + (out.source || 'gsc') + ').', 'success');
          }
        } else if (action === 'gsc-disconnect') {
          if (!confirm('Disconnect Google Search Console for this site? Already-collected keywords stay until you refresh.')) { btn.disabled = false; btn.textContent = originalText; return; }
          await api('DELETE', '/api/sites/' + siteId + '/gsc');
          showBanner('GSC disconnected.', 'info');
        } else if (action === 'disconnect') {
          if (!confirm('Disconnect this site? Articles already published stay on your WordPress.')) { btn.disabled = false; btn.textContent = originalText; return; }
          await api('DELETE', '/api/sites/' + siteId);
          showBanner('Site disconnected.', 'info');
        }
        await load();
      } catch (err) {
        showBanner(err.message, 'error');
        btn.disabled = false; btn.textContent = originalText;
      }
    }

    // After the OAuth redirect, ?gscConnected=<siteId> lands here. If the site
    // doesn't have a property selected yet, kick the picker.
    (function handleGscReturn() {
      const params = new URLSearchParams(window.location.search);
      const connectedId = params.get('gscConnected');
      const errorMsg = params.get('gscError');
      if (errorMsg) showBanner('Google declined: ' + errorMsg, 'error');
      if (connectedId) {
        history.replaceState({}, '', '/app/');
        // Wait for first load() so site list is populated, then trigger picker.
        const t = setInterval(() => {
          const sitesLoaded = document.querySelector('[data-settings-site=' + JSON.stringify(connectedId) + ']');
          if (sitesLoaded) { clearInterval(t); pickGscProperty(connectedId); }
        }, 200);
        setTimeout(() => clearInterval(t), 5000);
      }
    })();

    load();
  </script>
</body>
</html>`;
}
