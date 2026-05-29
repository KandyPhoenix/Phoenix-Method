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
    siteLimit: 1, // billing not live yet — every customer gets 1 site. Operator
                  // can bump via direct KV edit for paid customers.
    createdAt: nowIso(),
  };
  await env.CUSTOMERS.put(email, JSON.stringify(customer));
  return customer;
}

// How many sites this customer is allowed to connect. Defaults to 1 so
// existing customer records (which don't have the field) inherit the same
// limit without a migration. Operator can flip per-customer via KV edit
// when billing is wired up.
function siteLimitFor(customer) {
  return Number.isFinite(customer && customer.siteLimit) ? customer.siteLimit : 1;
}

// PM-271: plan helpers. Existing customer records may carry no plan field
// or the legacy 'trial' value — both are normalized here so the rest of the
// codebase can treat plan as a closed set: 'trial' | 'starter' | 'pro'.
const VALID_PLANS = ['trial', 'starter', 'pro'];
function customerPlan(customer) {
  const explicit = customer && customer.plan;
  if (VALID_PLANS.includes(explicit)) return explicit;
  // Back-compat for legacy records: active trial → 'trial', otherwise 'starter'.
  if (customer && customer.trialEnds && new Date(customer.trialEnds).getTime() > Date.now()) return 'trial';
  return 'starter';
}

// True when Phoenix Method covers the Ahrefs API bill for this customer.
// Today: Pro plan only. (Lower tiers can still use Ahrefs via BYOK key.)
function canUseSystemAhrefs(customer) {
  return customerPlan(customer) === 'pro';
}

// Resolves which Ahrefs key (if any) should be used for this customer. BYOK
// wins on any tier — the customer pays the bill. Otherwise system key, but
// only for Pro. Returns null when the customer can't use Ahrefs at all.
async function resolveAhrefsKey(env, customer) {
  if (customer && customer.ahrefsApiKey) {
    try { return await decryptSecret(customer.ahrefsApiKey, env.SESSION_SECRET); }
    catch { return null; }
  }
  if (canUseSystemAhrefs(customer) && env.AHREFS_API_KEY) return env.AHREFS_API_KEY;
  return null;
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
  const { appPassword, gsc, anthropicApiKey, githubToken, serpBearApiKey, ...safe } = site;
  return {
    ...safe,
    hasCredentials: Boolean(appPassword) || site.cms === 'manual' || (site.cms === 'github-pages' && Boolean(githubToken)),
    gsc: gsc ? { property: gsc.property || '', connected: true, connectedAt: gsc.connectedAt || null } : null,
    hasAnthropicKey: Boolean(anthropicApiKey),
    hasGithubToken: Boolean(githubToken),
    hasSerpBearKey: Boolean(serpBearApiKey),
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

async function ahrefsKeywords(env, niche, domain, apiKey) {
  if (!apiKey) {
    // No usable Ahrefs key for this customer (no BYOK + not Pro, or local dev
    // with no env key). Return a stub list derived from the niche so the
    // pipeline isn't blocked. Caller's empty-result path / LLM seed (PM-269)
    // will normally take over if this returns 0 items, so we keep this just
    // for dev environments.
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
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
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

// Ahrefs SERP overview: returns the top-N organic URLs ranking for `keyword`
// in `country`. Used by buildSerpBrief to know which pages to fetch + parse
// for heading/word-count patterns. Returns [] if no key (BYOK gate) or HTTP
// error so the pipeline degrades gracefully — the article still generates,
// just without a SERP brief in the prompt.
async function ahrefsSerpOverview(env, keyword, country, apiKey) {
  if (!apiKey || !keyword) return [];
  const params = new URLSearchParams({
    keyword,
    country: country || 'us',
    select: 'position,url,title,type',
    top_positions: '10',
  });
  let res;
  try {
    res = await fetch(`https://api.ahrefs.com/v3/serp-overview/serp-overview?${params}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error('ahrefs serp-overview network error', String(err.message || err));
    return [];
  }
  if (!res.ok) {
    console.error('ahrefs serp-overview failed', res.status, await res.text().catch(() => ''));
    return [];
  }
  const data = await res.json().catch(() => ({}));
  const rows = data.positions || data.serp || data.data || data.results || [];
  return rows
    .filter((r) => {
      if (!r || !r.url || !r.position || r.position > 10) return false;
      // Drop SERP features (paid, video, AI overview, etc.) — only organic
      // results have content patterns worth feeding to the writer.
      if (Array.isArray(r.type) && !r.type.includes('organic')) return false;
      return true;
    })
    .sort((a, b) => a.position - b.position)
    .slice(0, 10)
    .map((r) => ({ position: r.position, url: r.url, title: r.title || '' }));
}

// SerpBear (self-hosted rank tracker, free + open-source) keyword source.
// Customer adds their SerpBear URL + API key + tracked domain in Settings;
// we pull all keywords for that domain and shape into our schema. SerpBear
// doesn't have keyword difficulty (KD) so we leave it at 0; intent is
// heuristically guessed from the keyword text since SerpBear doesn't track
// it either. Volume comes from SerpBear's optional volume integration.
//
// API shape (SerpBear >= 1.2): GET <baseUrl>/api/keywords?domain=<domain>
// Auth: header `Authorization: <apiKey>` (no "Bearer" prefix — SerpBear uses
// the raw key value). On 401 we surface a clear error to the audit log.
async function serpBearKeywords(env, site) {
  if (!site.serpBearUrl || !site.serpBearApiKey) {
    await audit(env, site.id, 'keywords.serpbear.misconfigured', { hasUrl: Boolean(site.serpBearUrl), hasKey: Boolean(site.serpBearApiKey) });
    return [];
  }
  const apiKey = await decryptSecret(site.serpBearApiKey, env.SESSION_SECRET);
  const baseUrl = site.serpBearUrl.replace(/\/+$/, '');
  const domain = site.serpBearDomain || (() => { try { return new URL(site.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (!domain) {
    await audit(env, site.id, 'keywords.serpbear.no_domain', {});
    return [];
  }
  const url = `${baseUrl}/api/keywords?domain=${encodeURIComponent(domain)}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Authorization': apiKey, 'Accept': 'application/json' } });
  } catch (err) {
    await audit(env, site.id, 'keywords.serpbear.network_error', { error: String(err.message || err).slice(0, 200) });
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    await audit(env, site.id, 'keywords.serpbear.http_error', { status: res.status, body: body.slice(0, 300) });
    return [];
  }
  const data = await res.json().catch(() => null);
  // SerpBear returns either an array directly or { keywords: [...] } depending
  // on version. Handle both shapes.
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.keywords) ? data.keywords : []);
  return items
    .map((it) => {
      const kw = String(it.keyword || '').trim();
      if (!kw) return null;
      const text = kw.toLowerCase();
      // Cheap intent heuristic — SerpBear doesn't tag intent, so we infer
      // from the keyword text. Good enough for the keyword filter + prompt.
      let intent = 'informational';
      if (/\b(buy|price|pricing|cost|cheap|deal|coupon)\b/.test(text)) intent = 'commercial';
      else if (/\b(best|top|vs|versus|compare|review)\b/.test(text)) intent = 'commercial';
      else if (/\b(login|sign in|download|app)\b/.test(text)) intent = 'navigational';
      return {
        keyword: kw,
        volume: Number(it.volume) || 0,
        kd: 0, // SerpBear doesn't track difficulty
        intent,
      };
    })
    .filter(Boolean);
}

// ──────────────────────────────────────────────────────────────
// Topic clustering: group related keywords + designate a pillar for each
// cluster. Pure helpers — researchAndStoreKeywords calls clusterKeywords
// after merging sources, and pickNextKeyword prefers pillars over clusters.

// Strips a fixed stopword list, lowercase, splits on non-alphanumeric.
// Exported because callers occasionally want a deterministic tokenization
// (and because unit tests need to lock the stopword list down — silent
// changes to it would re-cluster every customer's inventory on next
// research refresh).
export function tokenizeKeyword(s) {
  const STOP = new Set([
    'a','an','the','of','for','in','to','and','or','vs','versus',
    'best','top','how','what','why','when','where','is','at','on',
    'with','from','your','my','their','our','it','this','that',
  ]);
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

// Jaccard-min token overlap: intersection / min(|A|, |B|). Favors
// containment — a short keyword sitting inside a longer one matches strongly,
// which is what we want for "running shoes" ⊂ "best running shoes for women".
function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  let inter = 0;
  for (const t of tokensB) if (setA.has(t)) inter++;
  return inter / Math.min(tokensA.length, tokensB.length);
}

// Groups keywords by ≥50% token overlap (transitively, via union-find) and
// designates a pillar per cluster = the keyword with the fewest stopword-
// stripped tokens (broadest term). Pure function; preserves input order in
// the output array. Each returned keyword gets:
//   - clusterId: 1-indexed integer, stable per call but not across calls
//   - isPillar:  true for exactly one keyword per cluster
// Keywords with no usable tokens (all-stopword inputs like "what is it")
// become singleton clusters with isPillar=true.
export function clusterKeywords(keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return [];
  const n = keywords.length;
  const tokens = keywords.map((k) => tokenizeKeyword(k && k.keyword));

  // Union-Find.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  for (let i = 0; i < n; i++) {
    if (!tokens[i].length) continue;
    for (let j = i + 1; j < n; j++) {
      if (!tokens[j].length) continue;
      if (tokenOverlap(tokens[i], tokens[j]) >= 0.5) union(i, j);
    }
  }

  // Assign 1-indexed clusterIds in order of first occurrence.
  const componentIdByRoot = {};
  let nextId = 1;
  const componentOf = [];
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!componentIdByRoot[root]) componentIdByRoot[root] = nextId++;
    componentOf[i] = componentIdByRoot[root];
  }

  // For each component, pillar = fewest tokens; tie → earliest input index
  // (which is highest-scoring upstream when called after scoreKeyword sort).
  const pillarIdxByCluster = {};
  for (let i = 0; i < n; i++) {
    const c = componentOf[i];
    const current = pillarIdxByCluster[c];
    if (current === undefined) { pillarIdxByCluster[c] = i; continue; }
    if (tokens[i].length < tokens[current].length) pillarIdxByCluster[c] = i;
  }

  return keywords.map((k, i) => ({
    ...k,
    clusterId: componentOf[i],
    isPillar: pillarIdxByCluster[componentOf[i]] === i,
  }));
}

function scoreKeyword(k) {
  // Buyer-intent first, then opportunity (high volume / low difficulty).
  // PM-267: manual (customer-curated) keywords get a fixed boost so they sort
  // above low-volume scraped results — if the customer explicitly added it,
  // they want it written about.
  const intentBonus = k.intent === 'commercial' || k.intent === 'transactional' ? 50 : 0;
  const manualBonus = k.isManual ? 100 : 0;
  const kd = Math.max(1, k.kd || 1);
  return manualBonus + intentBonus + Math.log2((k.volume || 0) + 1) * 10 - kd;
}

async function researchAndStoreKeywords(env, site) {
  const source = site.keywordSource || 'gsc';
  let raw = [];
  let usedSource = source;
  let seedKind = null;
  if (source === 'gsc') {
    if (site.gsc && site.gsc.property) {
      raw = await gscKeywords(env, site);
    } else {
      // PM-269: LLM seed when GSC is selected but not yet connected, so the
      // customer sees a real, varied chip list on first dashboard load.
      const seeded = await seedKeywords(env, site);
      raw = seeded.keywords;
      seedKind = seeded.kind;
      usedSource = seeded.kind === 'llm' ? 'llm-seed' : 'seed';
    }
  } else if (source === 'ahrefs') {
    // PM-271: resolve Ahrefs key. BYOK wins on any plan; system key only for
    // Pro. When neither is available, the empty-result fallback (LLM seed or
    // static seed via PM-269) covers the customer rather than 500ing.
    const customer = await getOrCreateCustomer(env, site.ownerEmail);
    const ahrefsKey = await resolveAhrefsKey(env, customer);
    if (!ahrefsKey) {
      await audit(env, site.id, 'keywords.ahrefs.unauthorized', { plan: customerPlan(customer), hasBYOK: Boolean(customer.ahrefsApiKey) });
      raw = [];
    } else {
      raw = await ahrefsKeywords(env, site.niche, new URL(site.url).hostname, ahrefsKey);
    }
  } else if (source === 'serpbear') {
    raw = await serpBearKeywords(env, site);
  } else if (source === 'manual') {
    // PM-267: mark manual-as-primary entries so they get the score boost +
    // skip the LLM relevance judge consistently with additive manual entries.
    raw = (await manualKeywords(site, site.manualKeywords || [])).map((k) => ({ ...k, isManual: true }));
  }
  // PM-267: manual keywords are additive on top of GSC / Ahrefs / SerpBear.
  // When the primary source is one of those, merge the customer's manual list
  // in (deduped against the source results by lowercased keyword text).
  // Skipped when source === 'manual' since that path already loaded them.
  if (source !== 'manual' && Array.isArray(site.manualKeywords) && site.manualKeywords.length) {
    const additions = (await manualKeywords(site, site.manualKeywords)).map((k) => ({ ...k, isManual: true }));
    const seen = new Set(raw.map((k) => String(k.keyword || '').toLowerCase().trim()));
    for (const m of additions) {
      const key = String(m.keyword || '').toLowerCase().trim();
      if (key && !seen.has(key)) {
        raw.push(m);
        seen.add(key);
      }
    }
  }
  // Universal fallback: if the primary source produced nothing (new GSC with
  // no rank-eligible queries, Ahrefs API quota, empty manual list…), seed the
  // queue. PM-269: prefer LLM-generated candidates over the static niche
  // template so the chip list is varied + actually useful.
  if (!raw.length) {
    const seeded = await seedKeywords(env, site);
    raw = seeded.keywords;
    seedKind = seeded.kind;
    usedSource = source + (seeded.kind === 'llm' ? '-llm-seed-fallback' : '-seed-fallback');
  }
  // PM-263: per-site blocklist. Anything the customer has explicitly removed
  // from the chip list is filtered out here, before scoring + LLM judging, so
  // it never comes back on refresh regardless of source.
  if (Array.isArray(site.keywordBlocklist) && site.keywordBlocklist.length) {
    const block = new Set(site.keywordBlocklist.map((s) => String(s).toLowerCase().trim()));
    raw = raw.filter((k) => !block.has(String(k.keyword || '').toLowerCase().trim()));
  }
  // PM-253 + PM-267: LLM-based relevance gate. Skips manual entries — if the
  // customer explicitly added a keyword, we trust their judgement and don't
  // let the LLM reject it. Verdicts are stored on each (non-manual) keyword
  // record so the dashboard can display rejections with reasons. Fail-open:
  // if the judge errors, we keep all candidates rather than blocking research.
  const filterMode = site.keywordFilter || 'auto';
  let verdicts = {};
  if (filterMode === 'auto' && raw.length) {
    const toJudge = raw.filter((k) => !k.isManual).map((k) => k.keyword);
    if (toJudge.length) verdicts = await judgeKeywordRelevance(env, site, toJudge);
  }
  const ranked = raw
    .map((k) => {
      const v = k.isManual
        ? { relevant: true, reason: '' }
        : (verdicts[k.keyword] || { relevant: true, reason: '' });
      return {
        ...k,
        score: scoreKeyword(k),
        picked: false,
        pickedAt: null,
        rejected: !v.relevant,
        rejectionReason: v.relevant ? null : (v.reason || 'Off-niche'),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
  // PM-283: topic clustering. Tags each keyword with clusterId + isPillar
  // so pickNextKeyword can prefer pillars (broader, authority-building
  // terms) over cluster keywords (narrower, supporting terms).
  const clustered = clusterKeywords(ranked);
  await env.KEYWORDS.put(`kws:${site.id}`, JSON.stringify(clustered));
  const rejectedCount = clustered.filter((k) => k.rejected).length;
  const manualCount = clustered.filter((k) => k.isManual).length;
  const pillarCount = clustered.filter((k) => k.isPillar).length;
  await audit(env, site.id, 'keywords.refreshed', { count: clustered.length, source: usedSource, rejected: rejectedCount, manual: manualCount, seedKind });
  await audit(env, site.id, 'keywords.clustered', {
    total: clustered.length,
    pillars: pillarCount,
    clusters: clustered.length - pillarCount,
  });
  return { list: clustered, source: usedSource, seedKind };
}

// Single batched LLM call that judges relevance of every candidate keyword
// against the site's niche. Returns { [keyword]: { relevant, reason } } map.
// Fail-open: any error → all keywords treated as relevant. The dashboard will
// still surface the audit log so we can spot a systematically-broken judge.
async function judgeKeywordRelevance(env, site, candidates) {
  if (!candidates || !candidates.length) return {};
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 800);
  const niche = site.niche || new URL(site.url).hostname;
  const list = candidates.map((k, i) => `${i + 1}. ${k}`).join('\n');
  const prompt = {
    system: `You judge whether candidate SEO keywords are on-topic for a specific website. You are conservative — when in doubt, accept the keyword. You only reject keywords that are CLEARLY about a different industry, a different brand that shares a word with this site's name, or geographic noise from people searching for unrelated local services.

Respond with a single JSON object matching this schema exactly:
{
  "verdicts": [
    { "keyword": string, "relevant": boolean, "reason": string }
  ]
}

The reason field should be short (1 sentence). For relevant=true, reason can be empty. For relevant=false, explain why concretely (don't just say "off-topic").`,
    user: `Site niche: ${niche}
Site URL: ${site.url}

Brand voice sample:
"""
${voiceSample}
"""

Candidate keywords:
${list}

Return verdicts for all ${candidates.length} candidates in the same order.`,
  };
  try {
    const result = await callLLM(env, site, prompt);
    if (!result.ok) {
      await audit(env, site.id, 'keywords.judge.error', { error: result.error });
      return {};
    }
    const out = {};
    const verdicts = (result.content && result.content.verdicts) || [];
    for (const v of verdicts) {
      if (v && typeof v.keyword === 'string') {
        out[v.keyword] = { relevant: v.relevant !== false, reason: String(v.reason || '').slice(0, 200) };
      }
    }
    return out;
  } catch (err) {
    await audit(env, site.id, 'keywords.judge.error', { error: String(err.message || err) });
    return {};
  }
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

// PM-269: dynamic LLM-driven seed keywords. Called from researchAndStoreKeywords
// in the two paths where we have no real source data: (a) GSC selected but not
// yet connected, (b) universal fallback when the primary source returned
// nothing. Returns 15-25 long-tail candidates tailored to the site's URL /
// niche / brand voice. Falls back to staticNicheSeeds on any LLM error / empty.
async function seedKeywords(env, site) {
  try {
    const llm = await llmSeedKeywords(env, site);
    if (llm && llm.length) return { keywords: llm, kind: 'llm' };
  } catch (err) {
    await audit(env, site.id, 'keywords.seed.llm_error', { error: String(err.message || err).slice(0, 200) });
  }
  return { keywords: staticNicheSeeds(site), kind: 'static' };
}

function staticNicheSeeds(site) {
  // The pre-PM-269 fallback. Used when the LLM seed call errors or returns
  // nothing usable. Deterministic niche-templated keywords so the pipeline
  // always has something to chew on.
  const niche = (site.niche || new URL(site.url).hostname || 'business').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ') || 'small business';
  return [
    { keyword: `best ${niche} services`, volume: 0, kd: 0, intent: 'commercial' },
    { keyword: `how to choose a ${niche} provider`, volume: 0, kd: 0, intent: 'informational' },
    { keyword: `${niche} pricing guide`, volume: 0, kd: 0, intent: 'commercial' },
    { keyword: `${niche} checklist`, volume: 0, kd: 0, intent: 'informational' },
  ];
}

async function llmSeedKeywords(env, site) {
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 800);
  const niche = site.niche || new URL(site.url).hostname || 'this business';
  const prompt = {
    system: `You generate SEO-promising long-tail keyword candidates (3-5 words each) for a website. Mix commercial-intent (buyer-ready: "buy", "best", "compare", "vs", "pricing", "review") with informational-intent (top-of-funnel: "how", "what", "guide", "checklist", "tips"). Avoid brand names. Avoid duplicates. All keywords lowercase.

Respond with a single JSON object matching this schema exactly:
{
  "keywords": [
    { "keyword": string, "intent": "commercial" | "informational" | "transactional" }
  ]
}

Return 15-25 keywords total.`,
    user: `Site URL: ${site.url}
Site niche: ${niche}

Brand voice sample:
"""
${voiceSample}
"""

Generate 15-25 long-tail SEO keyword candidates this site has a reasonable chance to rank for. Mix commercial and informational intent.`,
  };
  const result = await callLLM(env, site, prompt);
  if (!result.ok) {
    await audit(env, site.id, 'keywords.seed.llm_error', { error: result.error });
    return [];
  }
  const candidates = (result.content && result.content.keywords) || [];
  return candidates
    .map((c) => ({
      keyword: String((c && c.keyword) || '').trim().toLowerCase(),
      volume: 0,
      kd: 0,
      intent: ['commercial', 'informational', 'transactional'].includes(c && c.intent) ? c.intent : 'informational',
    }))
    .filter((k) => k.keyword && k.keyword.length <= 100)
    .slice(0, 25);
}

async function pickNextKeyword(env, siteId) {
  const raw = await env.KEYWORDS.get(`kws:${siteId}`);
  if (!raw) return null;
  const list = JSON.parse(raw);
  // Skip rejected entries — they stay on the record (visible in the dashboard
  // with strikethrough + reason) but never get fed to the article generator.
  // PM-283: prefer pillars over clusters. Build broad topical authority
  // first; supporting cluster articles fill in afterward. Falls back to any
  // unpicked keyword for older inventories that pre-date clustering.
  const next = list.find((k) => !k.picked && !k.rejected && k.isPillar)
            || list.find((k) => !k.picked && !k.rejected);
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

// Internal linking: gather a list of the customer's existing published posts
// so the LLM can weave 2-4 relevant links into the new article. For
// WordPress sites we hit the live /wp/v2/posts endpoint so the LLM also
// sees the customer's hand-written posts; for everything else (github-pages
// + manual) we use the per-site article index we keep in KV (covers our
// published posts, with their actual stored publicUrl so SSG URL patterns
// resolve correctly).
export async function fetchInternalLinkTargets(env, site, opts = {}) {
  const limit = opts.limit || 20;
  const targets = [];

  if (site.cms === 'wordpress') {
    try {
      const base = site.url.replace(/\/+$/, '');
      const res = await fetch(`${base}/wp-json/wp/v2/posts?per_page=${limit}&_fields=link,title,excerpt`, {
        headers: { 'User-Agent': 'PhoenixAI/1.0 (+https://phoenixmethodseo.com/phoenix-ai/)' },
      });
      if (res.ok) {
        const data = await res.json();
        for (const p of (Array.isArray(data) ? data : [])) {
          const link = p && p.link;
          const titleRaw = p && p.title && p.title.rendered;
          const excerptRaw = p && p.excerpt && p.excerpt.rendered;
          if (link && titleRaw) {
            targets.push({
              url: link,
              title: stripTagsCollapse(titleRaw),
              description: stripTagsCollapse(excerptRaw || '').slice(0, 160),
            });
          }
        }
      }
    } catch { /* fall through to KV */ }
  }

  if (!targets.length) {
    const indexRaw = await env.ARTICLES.get(`list:${site.id}`);
    const ids = indexRaw ? JSON.parse(indexRaw) : [];
    const items = await Promise.all(ids.slice(0, limit).map(async (id) => {
      const raw = await env.ARTICLES.get(`art:${site.id}:${id}`);
      if (!raw) return null;
      const a = JSON.parse(raw);
      if (!a.publicUrl || !a.title) return null;
      return { url: a.publicUrl, title: a.title, description: a.metaDescription || '' };
    }));
    for (const i of items) if (i) targets.push(i);
  }

  return targets;
}

export function stripTagsCollapse(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// After the LLM emits an article body, walk every <a href> and validate that
// internal anchors (same domain or relative) point to a real URL from the
// supplied list. External links (different hostname) pass through untouched —
// the prompt still asks for source citations and we don't want to scrub those.
// Anchors whose href isn't in the allowlist get unwrapped (text content kept,
// <a> tags removed). Returns the cleaned html plus a count of kept/stripped
// for the audit log so we can see when the LLM tries to hallucinate URLs.
export function validateInternalLinks(html, site, allowedUrls) {
  if (!allowedUrls || !allowedUrls.length) return { html, kept: 0, stripped: 0, total: 0 };
  const allowedSet = new Set(allowedUrls);
  let siteHost = '';
  try { siteHost = new URL(site.url).hostname; } catch { /* malformed site url, treat all as external */ }
  let kept = 0, stripped = 0, total = 0;
  const cleaned = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    total++;
    let isInternal = false;
    let normalized = href;
    if (siteHost) {
      try {
        const u = new URL(href, site.url);
        isInternal = u.hostname === siteHost;
        normalized = u.href;
      } catch { /* malformed href — treat as internal to be safe (strip) */ isInternal = true; }
    }
    if (!isInternal) { kept++; return match; }
    if (allowedSet.has(href) || allowedSet.has(normalized)) { kept++; return match; }
    stripped++;
    return inner;
  });
  return { html: cleaned, kept, stripped, total };
}

// ──────────────────────────────────────────────────────────────
// SERP brief: read what's actually ranking + feed patterns to the writer.
// Pure regex extractors below — exported so the test suite can hit them
// without spinning up a Workers runtime. The fetch + orchestration helpers
// stay internal (their I/O is what we don't want to mock in unit tests).

// Extracts the contents of the first <title> tag, tag-stripped + whitespace-
// collapsed. Returns '' when missing.
export function extractTitle(html) {
  if (!html) return '';
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Extracts the value of <meta name="description" content="..."> regardless
// of attribute order or single/double quotes. Returns '' when missing.
export function extractMetaDescription(html) {
  if (!html) return '';
  // Try the two common attribute orders separately — keeps the regex simple.
  let m = /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i.exec(html);
  if (!m) m = /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i.exec(html);
  return m ? m[1].trim() : '';
}

// Extracts H1/H2/H3 text content. Headings longer than 200 chars are dropped
// (nav menus and rendered template fragments occasionally collapse into a
// single <h2> on ad-heavy SERP pages — those are noise, not topics).
export function extractHeadings(html) {
  const out = { h1: [], h2: [], h3: [] };
  if (!html) return out;
  for (const tag of ['h1', 'h2', 'h3']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    while ((m = re.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 200) out[tag].push(text);
    }
  }
  return out;
}

// Rough word count of an HTML body. Strips <script> and <style> blocks (and
// then all tags) before splitting on whitespace. Within ~5-15% of "true"
// word count on real blog posts, which is good enough for sizing target
// articles against what's ranking.
export function estimateWordCount(html) {
  if (!html) return 0;
  const text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

// Statistical median, rounded. Returns null on empty input.
export function median(nums) {
  if (!Array.isArray(nums) || !nums.length) return null;
  const sorted = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Deduplicates strings using a normalized key (lowercase + alphanumerics +
// spaces only) while preserving the original casing/punctuation of the
// first occurrence. Order-preserving.
export function dedupNormalized(strings) {
  if (!Array.isArray(strings)) return [];
  const seen = new Set();
  const out = [];
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    const key = s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Fetches one top-result URL and runs the four extractors. Uses Cloudflare
// edge cache (24h) so popular keywords don't re-fetch the same page across
// customers. Returns null on any failure — orchestrator filters those out.
async function fetchAndParseTopResult(url) {
  if (!url) return null;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'PhoenixAI/1.0 (+https://phoenixmethodseo.com/phoenix-ai/)' },
      cf: { cacheTtl: 86400, cacheEverything: true },
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let html;
  try { html = await res.text(); }
  catch { return null; }
  // Some SERP-ranking pages are 500KB+ of inlined CSS/SVG. Cap the parser
  // input so the regex pass doesn't burn through worker CPU budget.
  if (html.length > 1_500_000) html = html.slice(0, 1_500_000);
  return {
    url,
    title: extractTitle(html),
    metaDescription: extractMetaDescription(html),
    headings: extractHeadings(html),
    wordCount: estimateWordCount(html),
  };
}

// Orchestrator: Ahrefs SERP → fetch top 10 in parallel → aggregate. Returns
// null when there's no Ahrefs key, no SERP data, or all fetches failed. The
// caller treats null as "skip the SERP-brief section of the prompt and ship
// the article anyway" — same graceful-degradation pattern as internal links.
async function buildSerpBrief(env, keyword, country, apiKey) {
  const positions = await ahrefsSerpOverview(env, keyword, country, apiKey);
  if (!positions.length) return null;
  const parsed = (await Promise.all(positions.map((p) => fetchAndParseTopResult(p.url)))).filter(Boolean);
  if (!parsed.length) return null;
  const allH2s = parsed.flatMap((p) => p.headings.h2);
  const wordCounts = parsed.map((p) => p.wordCount).filter((n) => n > 200);
  return {
    keyword,
    pagesAnalyzed: parsed.length,
    medianWordCount: median(wordCounts),
    commonH2Themes: dedupNormalized(allH2s).slice(0, 20),
    topResults: parsed.map((p) => ({ url: p.url, title: p.title, h2Count: p.headings.h2.length })),
  };
}

// Formats a SERP brief as a prompt section. Returns '' when brief is null
// (caller omits the section entirely so the writer doesn't see an empty
// placeholder and try to be helpful about it).
export function formatSerpBrief(brief) {
  if (!brief || !brief.commonH2Themes || !brief.commonH2Themes.length) return '';
  const wc = brief.medianWordCount ? `Median word count of ranking pages: ${brief.medianWordCount}` : '';
  const themes = brief.commonH2Themes.map((t) => `  - ${t}`).join('\n');
  return [
    `SERP brief (top ${brief.pagesAnalyzed} ranking pages for this keyword):`,
    wc,
    'Common H2 themes from top results:',
    themes,
    '',
    'Use this brief to make sure your article covers the terrain Google already rewards. Write better, more specific headings than the list above — do not copy them verbatim.',
  ].filter(Boolean).join('\n');
}

// ──────────────────────────────────────────────────────────────
// Multi-pass writing: draft → critique → revise. Pure helpers for splitting
// and re-splicing an article by H2 section. Used by runMultiPass so the
// rewriter LLM only touches the weakest sections (not the whole article).

// Splits article HTML into sections by <h2>. Returns [{ heading, block }]
// where block is the literal HTML from this <h2> through (but not including)
// the next <h2> — or end of string for the last one. Content before the
// first <h2> is captured as an intro with heading === ''.
export function splitArticleByH2(html) {
  if (!html) return [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    marks.push({
      start: m.index,
      heading: m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    });
  }
  if (!marks.length) return [{ heading: '', block: html }];
  const out = [];
  if (marks[0].start > 0) out.push({ heading: '', block: html.slice(0, marks[0].start) });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    out.push({ heading: marks[i].heading, block: html.slice(marks[i].start, end) });
  }
  return out;
}

// Substitutes revised section blocks into the article. revisionsMap is
// `{ heading: htmlBlock }`. Headings are matched case-insensitively against
// the article's actual H2s; unmatched revisions are silently ignored (the
// rewriter LLM occasionally edits a heading even when told not to). Returns
// `{ html, applied, requested }`. The applied counter is the diagnostic the
// audit log uses to detect when the rewriter ignored its constraints.
export function applyRevisions(html, revisionsMap) {
  const requested = revisionsMap && typeof revisionsMap === 'object'
    ? Object.keys(revisionsMap).filter((k) => typeof revisionsMap[k] === 'string' && revisionsMap[k]).length
    : 0;
  if (!html || !requested) return { html: html || '', applied: 0, requested };
  const normalize = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const byNorm = {};
  for (const [k, v] of Object.entries(revisionsMap)) {
    if (typeof v !== 'string' || !v) continue;
    byNorm[normalize(k)] = v;
  }
  const sections = splitArticleByH2(html);
  let applied = 0;
  const rewritten = sections.map((s) => {
    const replacement = s.heading ? byNorm[normalize(s.heading)] : null;
    if (replacement) {
      applied++;
      return replacement;
    }
    return s.block;
  });
  return { html: rewritten.join(''), applied, requested };
}

// ──────────────────────────────────────────────────────────────
// Fact-check pass: pure helpers for the claim-scoring output. The LLM call
// itself (runFactCheck) is internal — these are the aggregation + html
// annotation primitives that the test suite locks down.

// Reads either `plausibilityScore` or `score` off a claim, returns null if
// neither is a finite number. The dual-name lookup is defensive: prompt
// asks for `plausibilityScore` but Workers AI Llama 8B occasionally emits
// the shorter `score` instead.
function readClaimScore(claim) {
  if (!claim || typeof claim !== 'object') return null;
  if (Number.isFinite(claim.plausibilityScore)) return claim.plausibilityScore;
  if (Number.isFinite(claim.score)) return claim.score;
  return null;
}

// Counts claims overall, by type ("stat" / "citation" / "assertion" /
// "unknown"), and how many fall below the low-confidence threshold.
export function summarizeFactCheck(claims, threshold = 5) {
  const out = { total: 0, lowConfidence: 0, byType: {} };
  if (!Array.isArray(claims)) return out;
  for (const c of claims) {
    if (!c || typeof c !== 'object') continue;
    out.total++;
    const type = String(c.type || 'unknown');
    out.byType[type] = (out.byType[type] || 0) + 1;
    const score = readClaimScore(c);
    if (score !== null && score < threshold) out.lowConfidence++;
  }
  return out;
}

// Returns only the claims below the threshold. Skips claims with no usable
// score (we don't want to flag something the LLM declined to score — that's
// less signal than no signal).
export function lowConfidenceClaims(claims, threshold = 5) {
  if (!Array.isArray(claims)) return [];
  return claims.filter((c) => {
    const score = readClaimScore(c);
    return score !== null && score < threshold;
  });
}

function escapeHtmlAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Wraps each flagged claim's text in the article HTML with a <mark> tag
// carrying score + reason for the operator's approval-page preview.
// Case-insensitive plain-substring find — if the LLM paraphrased instead of
// quoting verbatim, that claim is silently skipped (we don't risk mangling
// the article to chase a fuzzy match). Returns `{ html, annotated }`.
export function annotateFlaggedClaims(html, claims) {
  if (!html || !Array.isArray(claims) || !claims.length) {
    return { html: html || '', annotated: 0 };
  }
  let result = html;
  let annotated = 0;
  for (const c of claims) {
    if (!c || typeof c.text !== 'string') continue;
    const text = c.text.trim();
    // 4-char floor — anything shorter risks a high-frequency false-positive
    // match (e.g. wrapping the word "is" everywhere).
    if (text.length < 4) continue;
    const lowerResult = result.toLowerCase();
    const idx = lowerResult.indexOf(text.toLowerCase());
    if (idx === -1) continue;
    const before = result.slice(0, idx);
    // Don't wrap if the match falls inside an HTML tag (between < and >).
    const ltCount = (before.match(/</g) || []).length;
    const gtCount = (before.match(/>/g) || []).length;
    if (ltCount > gtCount) continue;
    const matched = result.slice(idx, idx + text.length);
    const after = result.slice(idx + text.length);
    const score = readClaimScore(c);
    const safeScore = score === null ? '' : String(score);
    const reason = escapeHtmlAttr(c.reason || 'flagged for review');
    result = `${before}<mark class="pm-fact-flag" data-score="${safeScore}" title="${reason}">${matched}</mark>${after}`;
    annotated++;
  }
  return { html: result, annotated };
}

function buildArticlePrompt({ keyword, site, internalLinks, serpBrief }) {
  const intent = (keyword.intent || 'informational').toLowerCase();
  const niche = site.niche || 'general business';
  // brandVoiceOverride is a manually-curated paragraph that takes precedence
  // over the auto-crawled homepage sample. Used for clients whose existing
  // site doesn't represent the voice we want (thin content, placeholder copy,
  // or YMYL clients where we want to control tone tightly).
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 1500);
  return {
    system: `You are a senior SEO content writer at Phoenix Method, a working SEO agency. Your job is to write a single long-form article that ranks on Google and converts readers.

Length requirement (hard floor):
- Minimum 1,500 words in the html body. Maximum 2,200.
- This is non-negotiable. Articles under 1,500 words don't rank for competitive terms.
- Each H2 section gets at least 250-350 words. Don't write a section heading you can't substantively fill.
- If you finish a section early, expand it with: a concrete example, a step-by-step breakdown, a comparison to alternatives, a common mistake to avoid, or a specific data point.

Style guardrails:
- Plain English, no SEO-speak, no keyword stuffing, no marketing fluff.
- Match the brand voice sample given to you in word choice, sentence rhythm, and POV.
- Use proper H-hierarchy: one H1 (matches title), 5-8 H2s, optional H3s within H2s.
- Open with a punchy 2-3 sentence intro that answers the core question immediately.
- Do NOT include an FAQ or "Frequently Asked Questions" section in the html field. The Q&As go in the separate faqs JSON field below — the dashboard renders them visually beneath the article. Putting them in both places wastes tokens and risks truncation.
- Cite a source by name when stating a statistic (don't fabricate numbers — if you don't know one, drop the stat).
- Never use the word "delve". Avoid corporate buzzwords ("leverage", "synergy", "unlock", "elevate").
- No em-dash overuse. No bullet-list spam — only when listing actual discrete items.

Internal linking:
- Where it reads naturally, link to 2-4 of the existing pages provided in the user message as "Internal link targets". Use natural anchor text — never the bare URL, never "click here".
- Spread links across the article body — not all in the intro, not all in a single paragraph.
- Only use URLs from the provided list. Never invent a URL or guess a slug. If no link target naturally fits, ship the article without internal links — don't force them.
- Do NOT link to the same target more than once per article.
- If the "Internal link targets" section says "(none yet)", skip internal linking entirely.

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

Internal link targets (use 2-4 of these, only if naturally relevant; never invent URLs):
${formatInternalLinkTargets(internalLinks)}
${serpBrief ? '\n' + formatSerpBrief(serpBrief) + '\n' : ''}
Return only the JSON object.`,
  };
}

function formatInternalLinkTargets(links) {
  if (!links || !links.length) return '(none yet — skip internal linking for this article)';
  return links.slice(0, 20).map((l) => {
    const desc = l.description ? ` — ${l.description}` : '';
    return `- ${l.url} | ${l.title}${desc}`;
  }).join('\n');
}

// Multi-pass pass 1 — editor LLM scores the draft and names the 3 weakest
// sections. We only ask for the scores + section names, not full rewrites,
// because (a) editors are good at finding problems, (b) the cost stays low
// (~500 output tokens), (c) the next pass can rewrite with the original
// article as context.
function buildCritiquePrompt({ article, keyword, serpBrief, site }) {
  const intent = (keyword.intent || 'informational').toLowerCase();
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 1000);
  return {
    system: `You are a senior SEO editor at a working content agency. Score a draft article on four dimensions (each 1-10) and identify the THREE weakest H2 sections that most need rewriting.

Scoring rubric:
- serpCoverage: Does the article address the topics that top-ranking pages cover? Compare against the SERP brief.
- brandVoice: Does the article match the brand voice sample in word choice, sentence rhythm, POV?
- factualSpecificity: Does it use concrete examples, named sources, real numbers? Or is it generic fluff?
- antiFluff: Is it free of buzzwords ("leverage", "synergy", "unlock", "elevate"), em-dash overuse, marketing-speak, and the word "delve"?

Return ONLY a JSON object (no prose, no code fences, no commentary) matching this schema:
{
  "scores":      { "serpCoverage": int, "brandVoice": int, "factualSpecificity": int, "antiFluff": int },
  "overallScore": number,
  "weakestSections": [
    {
      "heading": string,  // EXACT H2 text from the article, verbatim — do not edit, summarize, or reword
      "issue":   string,  // ONE sentence describing what is wrong with this section
      "fix":     string   // ONE sentence describing the specific change the rewriter should make
    }
  ]
}

weakestSections must contain 0 to 3 entries. Use 0 if the article needs no rewrites (overallScore >= 9). Otherwise list the worst 1-3 sections by impact.`,
    user: `Target keyword: "${keyword.keyword}"
Search intent: ${intent}

${formatSerpBrief(serpBrief) || '(no SERP brief available)'}

Brand voice sample:
"""
${voiceSample}
"""

Draft article HTML:
"""
${article.html}
"""

Score it and identify weakest sections. Return only the JSON.`,
  };
}

// Multi-pass pass 2 — rewriter LLM revises ONLY the weakest sections. Keeps
// the same H2 heading text so applyRevisions can splice the result back in
// at the right slot.
function buildRevisePrompt({ article, critique, keyword, site }) {
  const voiceSample = (site.brandVoiceOverride || site.brandVoice || '').slice(0, 1000);
  const sectionsToRevise = (critique && Array.isArray(critique.weakestSections) ? critique.weakestSections : [])
    .map((s) => `## ${s.heading}\nIssue: ${s.issue}\nFix: ${s.fix}`)
    .join('\n\n');
  return {
    system: `You are a senior SEO writer revising specific sections of a draft article based on editor feedback. Rewrite ONLY the sections the editor flagged. Keep each section's H2 heading text EXACTLY VERBATIM — your output is spliced back into the original article by matching on heading text.

Style guardrails (unchanged from the original brief):
- Plain English, no SEO-speak, no keyword stuffing, no buzzwords.
- Match the brand voice sample.
- Each rewritten section must be at least 250-350 words.
- Cite a source by name when stating a statistic — do not fabricate numbers.
- Never use the word "delve". Avoid "leverage", "synergy", "unlock", "elevate".

Return ONLY a JSON object (no prose, no fences) mapping each H2 heading to the rewritten section HTML. The HTML for each section MUST start with the <h2> tag and include everything through the section body — no nested H2s, no FAQ, no closing wrapper:

{
  "Exact H2 Heading Text 1": "<h2>Exact H2 Heading Text 1</h2><p>rewritten body...</p><p>more body...</p>",
  "Exact H2 Heading Text 2": "<h2>Exact H2 Heading Text 2</h2><p>...</p>"
}

One key per section flagged by the editor. Do not add sections the editor did not flag.`,
    user: `Target keyword: "${keyword.keyword}"

Brand voice sample:
"""
${voiceSample}
"""

Original article HTML (for context — do not rewrite the whole thing):
"""
${article.html}
"""

Sections to revise (per editor feedback):

${sectionsToRevise}

Rewrite only those sections. Return the JSON map only.`,
  };
}

// Fact-check LLM prompt. Instructs the model to quote claim text VERBATIM
// from the article body so annotateFlaggedClaims can plain-substring-find
// each claim and wrap it with <mark> for the operator preview. The known-
// reputable-sources hint in the rubric isn't exhaustive — it just gives
// the model anchor examples for the high-score band.
function buildFactCheckPrompt({ article, keyword, site }) {
  const niche = site.niche || 'general business';
  return {
    system: `You are a careful fact-checker reviewing a draft article for plausibility. List every numeric claim, named source citation, and specific factual assertion. For each, score plausibility 1-10 and give one short reason.

Scoring rubric:
- 8-10: well-established, common knowledge, or a citation to a known reputable source (Pew, Gallup, CDC, FDA, BLS, OECD, peer-reviewed journals, US Census, Eurostat, World Bank)
- 5-7: plausible but unverified, ambiguous source, or close-to-known data but not exact
- 1-4: implausible, almost certainly hallucinated, cites a nonexistent study, or contradicts well-established facts

Quote each claim's text VERBATIM from the article body — do not paraphrase, summarize, or fix typos. The verbatim text is how the operator locates the claim in the article.

Claim types:
- "stat": a numeric statistic or percentage
- "citation": "according to X" / "studies show" / a named-source attribution
- "assertion": a specific factual claim about a person, place, organization, or event

Return ONLY a JSON object (no prose, no fences):
{
  "claims": [
    {
      "text":              string,  // VERBATIM substring from the article body
      "type":              "stat" | "citation" | "assertion",
      "plausibilityScore": int (1-10),
      "reason":            string  // one short sentence
    }
  ]
}

If the article has no factual claims worth checking, return { "claims": [] }.`,
    user: `Article niche: ${niche}
Target keyword: "${keyword.keyword}"

Article body HTML:
"""
${article.html}
"""

List all factual claims and score them. Return only the JSON.`,
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
// Llama 3.3 70B is the strongest free chat model on Workers AI as of mid-2026
// — noticeably better article quality than 8B at the same near-zero cost. We
// can use it now because generation runs via ctx.waitUntil() and isn't bounded
// by the request-response timeout (PM-248). If 70B becomes unavailable in a
// region, the LLM call returns ok:false and the job is marked failed; the
// customer can retry. We don't auto-fall-back to 8B because that would
// silently degrade quality without telling the customer.
const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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
    // env.AI.run for chat models returns one of three shapes depending on
    // the model + how strictly it followed the JSON instruction:
    //   1. { response: "<string>" }                        — text mode
    //   2. { response: { title, slug, html, ... } }        — structured-output mode (Workers AI parses it for us)
    //   3. just a raw string                               — older models
    // For case 2 we skip JSON.parse entirely and use the object as-is.
    const raw = result.response ?? result;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.title || raw.html || raw.slug)) {
      return {
        ok: true,
        content: raw,
        tokens: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
        model: WORKERS_AI_MODEL,
      };
    }
    // Coerce to a string we can JSON.parse. JSON.stringify on an object is
    // safer than String() because it produces valid JSON in most cases and
    // gives a readable diagnostic for the cases it doesn't.
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw === 'object') text = raw.text || raw.content || JSON.stringify(raw);
    else text = String(raw);
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
// Multi-pass writing orchestrator: draft → critique → revise. Returns
// `{ html, initialScore, finalScore, sectionsRevised, sectionsRequested,
// skipped }` where html is either the revised body or the original (any
// failure path returns the original — multi-pass must never make quality
// worse). Gated on site.multiPass + presence of a SERP brief (the critique
// pass has nothing to compare coverage against otherwise).
async function runMultiPass(env, site, article, keyword, serpBrief) {
  const out = {
    html: article.html,
    initialScore: null,
    finalScore: null,
    sectionsRevised: 0,
    sectionsRequested: 0,
    skipped: null,
  };
  if (!site.multiPass) { out.skipped = 'disabled'; return out; }
  if (!serpBrief || !serpBrief.commonH2Themes || !serpBrief.commonH2Themes.length) {
    out.skipped = 'no_serp_brief';
    return out;
  }
  if (!article || typeof article.html !== 'string' || !article.html) {
    out.skipped = 'no_article_html';
    return out;
  }

  // Pass 1: critique.
  const critiquePrompt = buildCritiquePrompt({ article, keyword, serpBrief, site });
  const critiqueRes = await callLLM(env, site, critiquePrompt);
  if (!critiqueRes.ok || !critiqueRes.content || typeof critiqueRes.content !== 'object') {
    out.skipped = 'critique_failed';
    return out;
  }
  const critique = critiqueRes.content;
  const overall = Number.isFinite(critique.overallScore) ? critique.overallScore : null;
  out.initialScore = overall;
  out.finalScore = overall;

  // No revision needed if score is high enough or editor flagged nothing.
  const weakest = Array.isArray(critique.weakestSections) ? critique.weakestSections : [];
  if (!weakest.length || (overall !== null && overall >= 8)) {
    out.skipped = overall !== null && overall >= 8 ? 'score_above_threshold' : 'no_weakest_sections';
    return out;
  }
  out.sectionsRequested = weakest.length;

  // Pass 2: revise the weakest sections.
  const revisePrompt = buildRevisePrompt({ article, critique, keyword, site });
  const reviseRes = await callLLM(env, site, revisePrompt);
  if (!reviseRes.ok || !reviseRes.content || typeof reviseRes.content !== 'object' || Array.isArray(reviseRes.content)) {
    out.skipped = 'revise_failed';
    return out;
  }

  // Splice revised sections back into the article. applyRevisions tolerates
  // mismatched-heading keys so we don't lose the article when the rewriter
  // ignores its constraints.
  const result = applyRevisions(article.html, reviseRes.content);
  if (result.applied > 0) {
    out.html = result.html;
    out.sectionsRevised = result.applied;
    // We don't re-score after revising — the savings of a third pass aren't
    // worth the wait, and the audit log captures sectionsRevised which the
    // operator can spot-check on a sample.
  } else {
    out.skipped = 'revisions_did_not_match_any_section';
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Fact-check orchestrator: identify factual claims, surface low-confidence
// ones in the audit log, and annotate them inline with <mark> tags so the
// approval-page preview highlights them for operator review. Best-effort —
// any failure (no key, invalid JSON, no claims) leaves the article
// unchanged. Returns `{ html, claimsFound, lowConfidence, annotated,
// byType, skipped }`.
async function runFactCheck(env, site, article, keyword) {
  const out = {
    html: article ? article.html : '',
    claimsFound: 0,
    lowConfidence: 0,
    annotated: 0,
    byType: {},
    skipped: null,
  };
  if (!site.factCheck) { out.skipped = 'disabled'; return out; }
  if (!article || typeof article.html !== 'string' || !article.html) {
    out.skipped = 'no_article_html';
    return out;
  }
  const prompt = buildFactCheckPrompt({ article, keyword, site });
  const res = await callLLM(env, site, prompt);
  if (!res.ok || !res.content || typeof res.content !== 'object') {
    out.skipped = 'llm_failed';
    return out;
  }
  const claims = Array.isArray(res.content.claims) ? res.content.claims : [];
  const summary = summarizeFactCheck(claims);
  out.claimsFound = summary.total;
  out.lowConfidence = summary.lowConfidence;
  out.byType = summary.byType;
  if (!summary.lowConfidence) {
    out.skipped = 'no_low_confidence_claims';
    return out;
  }
  const low = lowConfidenceClaims(claims);
  const ann = annotateFlaggedClaims(article.html, low);
  if (ann.annotated > 0) {
    out.html = ann.html;
    out.annotated = ann.annotated;
  } else {
    out.skipped = 'no_claims_found_verbatim_in_html';
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Pipeline: WordPress REST publish

// Builds the same Article + BreadcrumbList + FAQPage JSON-LD that
// blogPostHTML embeds in github-pages posts, but as a standalone string of
// <script> tags. Used by wpPublish to prepend schema to the WP body content
// since WordPress themes own the <head> and most WP sites without an SEO
// plugin (Yoast / RankMath / SEOPress) ship with no Article schema at all.
async function buildArticleSchemaTags(env, site, article, canonical) {
  const brandName = siteBrandName(site);
  const blogPath = site.blogPath || 'blog';
  const baseUrl = site.url.replace(/\/+$/, '');
  const firstPublishedAt = await getOrInitFirstPublishedAt(env, site.id, article.slug, nowIso);
  const modifiedAt = nowIso();
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title || '',
    description: article.metaDescription || '',
    datePublished: firstPublishedAt,
    dateModified: modifiedAt,
    inLanguage: 'en',
    author: { '@type': 'Organization', name: brandName, url: baseUrl },
    publisher: { '@type': 'Organization', name: brandName, url: baseUrl },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl + '/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${baseUrl}/${blogPath}/` },
      { '@type': 'ListItem', position: 3, name: article.title || '', item: canonical },
    ],
  };
  const faqSchema = (article.faqs && article.faqs.length) ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: article.faqs.map((f) => ({
      '@type': 'Question',
      name: String(f.q || ''),
      acceptedAnswer: { '@type': 'Answer', text: String(f.a || '') },
    })),
  } : null;
  return [articleSchema, breadcrumbSchema, faqSchema]
    .filter(Boolean)
    .map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
    .join('\n');
}

async function wpPublish(env, site, article, status = 'draft') {
  const appPassword = await decryptSecret(site.appPassword, env.SESSION_SECRET);
  if (!appPassword || !site.appUsername) return { ok: false, error: 'missing WP credentials' };

  const base = site.url.replace(/\/+$/, '');
  const endpoint = `${base}/wp-json/wp/v2/posts`;
  const auth = 'Basic ' + btoa(`${site.appUsername}:${appPassword}`);

  // Best-guess canonical for the JSON-LD. WP permalink structures vary
  // (date prefix, category prefix, plain slug), but mainEntityOfPage
  // mismatch is harmless — the theme's rel=canonical in <head> is what
  // Google uses to dedupe; the JSON-LD is just for rich-result eligibility.
  const canonical = `${base}/${article.slug}/`;
  const schemaTags = await buildArticleSchemaTags(env, site, article, canonical);
  const contentWithSchema = schemaTags + '\n' + (article.html || '');

  const payload = {
    title: article.title,
    slug: article.slug,
    content: contentWithSchema,
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
  await audit(env, site.id, 'pipeline.wp.schema_injected', { slug: article.slug, hasFaq: Boolean(article.faqs && article.faqs.length) });
  return {
    ok: true,
    wpPostId: data.id,
    wpEditUrl: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
    publicUrl: data.link,
  };
}

// Hard-delete a WordPress post (skip the trash). force=true is required;
// without it WP just moves the post to the trash and the customer would still
// see it in /wp-admin/edit.php?post_status=trash.
async function wpDelete(env, site, postId) {
  const appPassword = await decryptSecret(site.appPassword, env.SESSION_SECRET);
  if (!appPassword || !site.appUsername) return { ok: false, error: 'missing WP credentials' };
  const base = site.url.replace(/\/+$/, '');
  const endpoint = `${base}/wp-json/wp/v2/posts/${postId}?force=true`;
  const auth = 'Basic ' + btoa(`${site.appUsername}:${appPassword}`);
  const res = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: auth } });
  if (res.ok) return { ok: true };
  // 404 means the post was already gone on the WP side; treat as success so
  // the customer can recover from a half-deleted state by re-clicking Delete.
  if (res.status === 404) return { ok: true, alreadyGone: true };
  const body = await res.text().catch(() => '');
  return { ok: false, error: `wp ${res.status}: ${body.slice(0, 300)}` };
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

// Display name used in <title> brand suffix, JSON-LD author/publisher, and
// OG site_name. Customer can override via site.brandName; otherwise we derive
// from the URL hostname (drop www., drop TLD, title-case the remainder).
// "phoenixmethodseo.com" → "Phoenixmethodseo"; "lori-sleep-hub.com" → "Lori Sleep Hub".
function siteBrandName(site) {
  if (site.brandName && String(site.brandName).trim()) return String(site.brandName).trim();
  try {
    const host = new URL(site.url).hostname.replace(/^www\./, '');
    const stem = host.replace(/\.[a-z.]+$/i, '');
    return stem.split(/[-_.]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || host;
  } catch {
    return '';
  }
}

// First-publish timestamp lookup. Keyed by slug (not articleId) so re-running
// the same keyword — which produces a new articleId each time but the same
// slug — preserves the original publish date. Without this, datePublished
// resets every regenerate and Google loses the article's age signal.
async function getOrInitFirstPublishedAt(env, siteId, slug, nowIsoFn) {
  const key = `firstpub:${siteId}:${slug}`;
  const existing = await env.ARTICLES.get(key);
  if (existing) return existing;
  const now = nowIsoFn();
  await env.ARTICLES.put(key, now);
  return now;
}

// IndexNow: free, instant-indexing protocol supported by Bing, Yandex, Seznam,
// Naver, and IndexNow.org's network. Key file must be hosted at the site root
// (we commit it to the github-pages repo). One key per site, stored on the
// site record; generated lazily on first publish.
async function getOrCreateIndexNowKey(env, site) {
  if (site.indexNowKey && /^[a-f0-9]{32,}$/i.test(site.indexNowKey)) return site.indexNowKey;
  const key = uuid().replace(/-/g, '');
  site.indexNowKey = key;
  await saveSite(env, site);
  return key;
}

async function ensureIndexNowKeyFile(token, site, branch, key) {
  const path = `${key}.txt`;
  const existing = await ghGetFile(token, site.repoOwner, site.repoName, branch, path);
  if (!existing.ok) return existing;
  if (existing.exists && (existing.content || '').trim() === key) return { ok: true };
  return ghPutFile(token, site.repoOwner, site.repoName, branch, path, key, 'Phoenix AI: IndexNow key', existing.sha);
}

async function pingIndexNow({ keyHost, key, urls }) {
  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: keyHost, key, keyLocation: `https://${keyHost}/${key}.txt`, urlList: urls }),
  });
  if (res.ok || res.status === 202) return { ok: true, status: res.status };
  const body = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: body.slice(0, 200) };
}

// Sitemap.xml: rewrite from the blog index manifest each publish. We only
// manage sitemaps that carry our marker comment so a customer's hand-built
// or generator-built (Jekyll, etc.) sitemap is never clobbered.
const SITEMAP_MARKER = '<!-- phoenix-ai:managed -->';

function buildSitemapXml(site, articles) {
  const baseUrl = site.url.replace(/\/+$/, '');
  const blogPath = site.blogPath || 'blog';
  const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const urls = [
    { loc: `${baseUrl}/`, lastmod: null, priority: '1.0' },
    { loc: `${baseUrl}/${blogPath}/`, lastmod: articles[0] ? (articles[0].publishedAt || '').slice(0, 10) : null, priority: '0.9' },
    ...articles.map((a) => ({
      loc: `${baseUrl}/${blogPath}/${a.slug}.html`,
      lastmod: (a.publishedAt || '').slice(0, 10),
      priority: '0.8',
    })),
  ];
  const entries = urls.map((u) =>
    `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>` +
    (u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : '') +
    `\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${SITEMAP_MARKER}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

async function updateSitemapXml(token, site, articles, branch) {
  const path = 'sitemap.xml';
  const existing = await ghGetFile(token, site.repoOwner, site.repoName, branch, path);
  if (!existing.ok) return existing;
  if (existing.exists && !(existing.content || '').includes(SITEMAP_MARKER)) {
    return { ok: false, skipped: true, reason: 'customer-managed sitemap.xml found (no phoenix-ai marker) — not modifying' };
  }
  const xml = buildSitemapXml(site, articles);
  return ghPutFile(token, site.repoOwner, site.repoName, branch, path, xml, `Phoenix AI: update sitemap.xml`, existing.sha);
}

function blogPostHTML({ site, article, faqHtml, imageUrl, firstPublishedAt, modifiedAt }) {
  // Minimal blog post template. Includes /assets/site-chrome.{css,js} so if
  // the customer's repo has them (like phoenixmethodseo.com does), the page
  // automatically inherits their site's nav + footer + design tokens. If
  // those files don't exist in the repo, the inline fallback styles still
  // produce a readable page.
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brandName = siteBrandName(site);
  const brandNameEsc = escape(brandName);
  const rawTitle = article.title || '';
  // Brand suffix on <title> for SERP click-through. Skipped when the title
  // already contains the brand so we don't double it up.
  const titleWithBrand = brandName && !rawTitle.toLowerCase().includes(brandName.toLowerCase())
    ? `${rawTitle} | ${brandName}`
    : rawTitle;
  const titleEsc = escape(titleWithBrand);
  const ogTitleEsc = escape(rawTitle);
  const descEsc = escape(article.metaDescription || '');
  const canonical = `${site.url.replace(/\/+$/, '')}/${site.blogPath || 'blog'}/${article.slug}.html`;
  const absImage = imageUrl ? `${site.url.replace(/\/+$/, '')}${imageUrl}` : '';
  // FLUX now generates 1280x720 (16:9 banner). Reflect that in og:image
  // dimensions so social previews don't crop weirdly.
  const ogImage = absImage
    ? `<meta property="og:image" content="${absImage}">\n<meta property="og:image:width" content="1280">\n<meta property="og:image:height" content="720">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${absImage}">`
    : '';
  const heroFigure = imageUrl
    ? `<figure class="hero"><img src="${imageUrl}" alt="${escape(rawTitle)}" loading="eager" width="1280" height="720"></figure>`
    : '';
  // JSON-LD structured data: Article + BreadcrumbList + FAQPage. Google uses
  // these for rich results (article cards, breadcrumb display in SERPs, FAQ
  // expansion). Skips FAQPage if the article has no FAQs.
  const blogPath = site.blogPath || 'blog';
  // datePublished is preserved across re-runs (first-publish timestamp from KV)
  // so regenerating a post doesn't reset Google's freshness/age trust signal.
  // dateModified always reflects this run.
  const publishedIso = firstPublishedAt || new Date().toISOString();
  const modifiedIso = modifiedAt || new Date().toISOString();
  const jsonEscape = (s) => String(s == null ? '' : s).replace(/[\\" -]/g, (c) => {
    if (c === '\\' || c === '"') return '\\' + c;
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: rawTitle,
    description: article.metaDescription || '',
    image: absImage || undefined,
    datePublished: publishedIso,
    dateModified: modifiedIso,
    inLanguage: 'en',
    author: { '@type': 'Organization', name: brandName, url: site.url.replace(/\/+$/, '') },
    publisher: { '@type': 'Organization', name: brandName, url: site.url.replace(/\/+$/, '') },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: site.url.replace(/\/+$/, '') + '/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${site.url.replace(/\/+$/, '')}/${blogPath}/` },
      { '@type': 'ListItem', position: 3, name: rawTitle, item: canonical },
    ],
  };
  const faqSchema = (article.faqs && article.faqs.length) ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: article.faqs.map((f) => ({
      '@type': 'Question',
      name: String(f.q || ''),
      acceptedAnswer: { '@type': 'Answer', text: String(f.a || '') },
    })),
  } : null;
  const schemaTags = [articleSchema, breadcrumbSchema, faqSchema].filter(Boolean).map((s) =>
    `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleEsc}</title>
<meta name="description" content="${descEsc}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${ogTitleEsc}">
<meta property="og:description" content="${descEsc}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${brandNameEsc}">
<meta property="article:published_time" content="${publishedIso}">
<meta property="article:modified_time" content="${modifiedIso}">
<meta property="article:author" content="${brandNameEsc}">
${ogImage}
${schemaTags}
<link rel="stylesheet" href="/assets/site-chrome.css">
<style>
  body { font-family: 'Outfit', system-ui, sans-serif; line-height: 1.7; background: #07070D; color: #E8E8F0; margin: 0; }
  .blog-post { max-width: 720px; margin: 60px auto; padding: 0 24px; }
  .blog-post .hero { margin: 0 0 28px; }
  .blog-post .hero img { width: 100%; aspect-ratio: 16/9; object-fit: cover; max-height: 360px; border-radius: 12px; display: block; }
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

// Marker pair that scopes Phoenix AI's article-list block inside a customer's
// hand-curated index.html. Anything outside the markers is preserved untouched.
const PHOENIX_LIST_START = '<!--PHOENIX-AI-LIST-START-->';
const PHOENIX_LIST_END = '<!--PHOENIX-AI-LIST-END-->';

// Inner block injected between the markers. Minimal semantic markup using
// phoenix-ai-* class names so the customer's CSS can style it however they
// want. The JSON manifest comment lives inside this block so we can read it
// back on the next publish without scanning the rest of the file.
function buildArticleListBlock({ site, articles }) {
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const blogPath = site.blogPath || 'blog';
  const items = articles.map((a) => {
    const thumb = a.imageUrl ? `<img src="${a.imageUrl}" alt="" loading="lazy" width="240" height="240">` : '';
    const date = a.publishedAt ? a.publishedAt.slice(0, 10) : '';
    return `  <li class="phoenix-ai-article"><a href="/${blogPath}/${a.slug}.html">${thumb}<h3>${escape(a.title)}</h3><p>${escape(a.metaDescription || '')}</p>${date ? `<time datetime="${date}">${date}</time>` : ''}</a></li>`;
  }).join('\n');
  return `<!--PHOENIX-AI-MANIFEST:${b64utf8(JSON.stringify(articles))}:END-->
<ul class="phoenix-ai-articles">
${items}
</ul>`;
}

function blogIndexHTML({ site, articles }) {
  // Default template used only when the customer has no /blog/index.html yet.
  // Wraps the article-list block in the markers so future publishes go through
  // the marker-aware injection path uniformly.
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
  .phoenix-ai-articles { list-style: none; padding: 0; }
  .phoenix-ai-article { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 22px 0; }
  .phoenix-ai-article a { display: grid; grid-template-columns: 120px 1fr; gap: 18px; color: inherit; text-decoration: none; align-items: center; }
  .phoenix-ai-article a:not(:has(img)) { grid-template-columns: 1fr; }
  .phoenix-ai-article img { width: 120px; height: 120px; object-fit: cover; border-radius: 8px; grid-row: span 3; }
  .phoenix-ai-article h3 { font-family: 'Cinzel', serif; font-size: 1.3rem; margin-bottom: 6px; }
  .phoenix-ai-article p { color: #8888A0; margin: 0 0 4px; }
  .phoenix-ai-article time { font-size: 0.82rem; color: #555570; }
  .phoenix-ai-article a:hover h3 { color: #FF8C00; }
  @media (max-width: 540px) { .phoenix-ai-article a { grid-template-columns: 1fr; } .phoenix-ai-article img { width: 100%; height: 200px; } }
</style>
</head>
<body>
<div id="pm-nav"></div>
<main class="blog-index">
<h1>Blog</h1>
${PHOENIX_LIST_START}
${buildArticleListBlock({ site, articles })}
${PHOENIX_LIST_END}
</main>
<div id="pm-footer"></div>
<script src="/assets/site-chrome.js" defer></script>
</body>
</html>
`;
}

function parseIndexManifest(html) {
  // Returns the list previously embedded by buildArticleListBlock, or [] if
  // missing. Works whether the manifest is inside the marker block or not.
  const m = html.match(/<!--PHOENIX-AI-MANIFEST:([A-Za-z0-9+/=]+):END-->/);
  if (!m) return [];
  try { return JSON.parse(utf8FromB64(m[1])); }
  catch { return []; }
}

// Decides what to do with the customer's existing /blog/index.html when we
// need to refresh the article list. Three modes:
//
//   1. 'markers'  — file has the PHOENIX-AI-LIST-START/END markers. We replace
//                   only the content between them. Customer keeps full control
//                   of everything else (hero, custom CSS, schema, CTA cards).
//
//   2. 'managed'  — file has PHOENIX-AI-MANIFEST signature but no markers. It
//                   was generated by a previous version of Phoenix AI before
//                   the marker pattern existed. Safe to fully rewrite using
//                   the default template (which embeds markers going forward).
//
//   3. 'new'      — no existing file. Generate from the default template.
//
//   skipped       — file exists but has neither markers nor a Phoenix-AI
//                   signature. It's hand-curated and we refuse to touch it.
//                   Article publish still succeeds; dashboard surfaces a
//                   warning telling the customer to add the marker block.
function injectArticleList({ existingHtml, exists, site, articles }) {
  if (!exists) {
    return { ok: true, mode: 'new', html: blogIndexHTML({ site, articles }) };
  }
  const startIdx = existingHtml.indexOf(PHOENIX_LIST_START);
  const endIdx = existingHtml.indexOf(PHOENIX_LIST_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingHtml.slice(0, startIdx + PHOENIX_LIST_START.length);
    const after = existingHtml.slice(endIdx);
    const inner = '\n' + buildArticleListBlock({ site, articles }) + '\n';
    return { ok: true, mode: 'markers', html: before + inner + after };
  }
  // Legacy: previous Phoenix-AI-generated index without markers. Full rewrite
  // is safe because no human curation lives in there.
  if (/<!--PHOENIX-AI-MANIFEST:/.test(existingHtml)) {
    return { ok: true, mode: 'managed', html: blogIndexHTML({ site, articles }) };
  }
  // Hand-curated file with no opt-in markers. Refuse to overwrite.
  return {
    ok: false,
    skipped: true,
    reason: `Your /${site.blogPath || 'blog'}/index.html is hand-curated and has no Phoenix AI marker block. The article was published, but not added to the index. Paste <!--PHOENIX-AI-LIST-START--><!--PHOENIX-AI-LIST-END--> into the index file where you want articles listed, then re-publish or wait for the next article.`,
  };
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

async function ghDeleteFile(token, owner, repo, branch, filePath, sha, message) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: ghHeaders(token),
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `github ${res.status} on DELETE ${filePath}: ${errBody.slice(0, 300)}` };
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
    // Request 16:9 banner dimensions instead of the 1024x1024 default. A
    // square hero takes up the entire viewport on mobile; a banner is what
    // blog readers expect at the top of a post.
    const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, width: 1280, height: 720 });
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

  // Static-site-generator routing (pre-step). Customer can pin a result via
  // site.ssgOverride: 'jekyll' | 'hugo' | 'none' (skips detection). If
  // detection finds Jekyll or Hugo, we hand off to the SSG adapter so the
  // post lands inside the customer's build pipeline (theme, sitemap, RSS,
  // archive — all theirs). Otherwise we fall through to the standalone-HTML
  // path that's been here since v1.
  if (site.ssgOverride !== 'none') {
    const ssg = site.ssgOverride && site.ssgOverride !== 'auto'
      ? presetSSG(site.ssgOverride)
      : await detectGithubPagesSSG(token, site.repoOwner, site.repoName, branch);
    if (ssg) return publishSSGPost(env, site, article, ssg, token, branch);
  }

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
  const firstPublishedAt = await getOrInitFirstPublishedAt(env, site.id, article.slug, nowIso);
  const modifiedAt = nowIso();
  const postHtml = blogPostHTML({ site, article, faqHtml, imageUrl, firstPublishedAt, modifiedAt });
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
  // article (or replace if same slug already there), then ask injectArticleList
  // to decide whether to rewrite the file or refuse (hand-curated, no markers).
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
  const inject = injectArticleList({
    existingHtml: idx.content || '',
    exists: Boolean(idx.exists),
    site,
    articles: updated,
  });

  const publicUrl = `${site.url.replace(/\/+$/, '')}/${blogPath}/${article.slug}.html`;
  const editUrl = `https://github.com/${site.repoOwner}/${site.repoName}/edit/${branch}/${postPath}`;

  if (inject.skipped) {
    // Hand-curated index — article published but not added to the list. The
    // pipeline surfaces inject.reason to the customer via the article record.
    await audit(env, site.id, 'pipeline.index.skipped', { slug: article.slug, reason: inject.reason });
    return { ok: true, publicUrl, wpEditUrl: editUrl, wpPostId: null, imageUrl, indexWarning: inject.reason };
  }

  const idxPut = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, indexPath, inject.html,
    `Phoenix AI: update blog index (${article.slug})`,
    idx.sha,
  );
  if (!idxPut.ok) return idxPut;

  // 4. Post-publish SEO: rewrite sitemap.xml + ping IndexNow. Both are
  // best-effort — the article is already live, so failures are logged but
  // don't propagate as a publish error.
  await postPublishSEO(env, site, token, branch, publicUrl, updated);

  return { ok: true, publicUrl, wpEditUrl: editUrl, wpPostId: null, imageUrl };
}

// Sitemap + IndexNow: runs after the article + index commit lands. Each step
// audit-logs success/failure independently so a sitemap glitch doesn't hide an
// IndexNow problem and vice versa.
async function postPublishSEO(env, site, token, branch, publicUrl, manifestArticles) {
  // Sitemap
  try {
    const sm = await updateSitemapXml(token, site, manifestArticles, branch);
    if (sm.ok) await audit(env, site.id, 'pipeline.sitemap.updated', { url: publicUrl });
    else if (sm.skipped) await audit(env, site.id, 'pipeline.sitemap.skipped', { reason: sm.reason });
    else await audit(env, site.id, 'pipeline.sitemap.failed', { error: sm.error });
  } catch (err) {
    await audit(env, site.id, 'pipeline.sitemap.failed', { error: String(err.message || err).slice(0, 200) });
  }
  // IndexNow
  try {
    const key = await getOrCreateIndexNowKey(env, site);
    const keyFile = await ensureIndexNowKeyFile(token, site, branch, key);
    if (!keyFile.ok) {
      await audit(env, site.id, 'pipeline.indexnow.key_failed', { error: keyFile.error });
      return;
    }
    const keyHost = new URL(site.url).hostname;
    const ping = await pingIndexNow({ keyHost, key, urls: [publicUrl] });
    if (ping.ok) await audit(env, site.id, 'pipeline.indexnow.pinged', { url: publicUrl, status: ping.status });
    else await audit(env, site.id, 'pipeline.indexnow.failed', { status: ping.status, error: ping.error });
  } catch (err) {
    await audit(env, site.id, 'pipeline.indexnow.failed', { error: String(err.message || err).slice(0, 200) });
  }
}

// ──────────────────────────────────────────────────────────────
// Static site generator (Jekyll / Hugo) detection + publish.
//
// Most github-pages blogs use a static site generator (Jekyll is the default;
// Hugo is the popular alternative). When we commit raw HTML to those repos,
// the post bypasses the build pipeline and ends up with no theme styling, no
// nav/footer, no sitemap entry, no RSS, no archive page — orphaned in the
// repo tree. The fix is to commit a content file (markdown or HTML with
// front-matter) into the directory the generator watches; their build then
// renders the post with the customer's own theme and wires it into RSS +
// archives automatically.
//
// Detection is conservative — we require multiple signals to classify so a
// stray _config.yml or config.toml on a non-SSG repo can't false-positive
// us into writing to a directory that doesn't exist.
//
// Today: Jekyll + Hugo. 11ty/Astro/Gatsby are next if needed.

// Hardcoded SSG presets — used when the customer manually pins
// site.ssgOverride. Skips the auto-detection probes (faster + works on repos
// where the detection heuristic guesses wrong).
function presetSSG(type) {
  if (type === 'jekyll') return { type: 'jekyll', postsDir: '_posts', imageDir: 'assets/blog', imageUrlPrefix: '/assets/blog' };
  if (type === 'hugo') return { type: 'hugo', postsDir: 'content/posts', imageDir: 'static/blog', imageUrlPrefix: '/blog' };
  if (type === 'eleventy') return { type: 'eleventy', postsDir: 'src/posts', imageDir: 'src/images', imageUrlPrefix: '/images' };
  if (type === 'astro') return { type: 'astro', postsDir: 'src/content/blog', imageDir: 'public/blog', imageUrlPrefix: '/blog' };
  return null;
}

async function detectGithubPagesSSG(token, owner, repo, branch) {
  // Jekyll: _config.yml at root AND _posts directory present
  const jekyllConfig = await ghGetFile(token, owner, repo, branch, '_config.yml');
  if (jekyllConfig.ok && jekyllConfig.exists) {
    const postsDir = await ghContentsList(token, owner, repo, branch, '_posts');
    if (postsDir.ok && postsDir.isDir) {
      return { type: 'jekyll', postsDir: '_posts', imageDir: 'assets/blog', imageUrlPrefix: '/assets/blog' };
    }
  }
  // Hugo: hugo.toml / config.toml / config.yaml at root AND content/ directory
  for (const cfg of ['hugo.toml', 'hugo.yaml', 'config.toml', 'config.yaml']) {
    const hugoConfig = await ghGetFile(token, owner, repo, branch, cfg);
    if (hugoConfig.ok && hugoConfig.exists) {
      // Hugo customers vary content layout: content/posts/, content/blog/, content/post/.
      // Probe in that order; first directory wins.
      for (const dir of ['content/posts', 'content/blog', 'content/post']) {
        const probe = await ghContentsList(token, owner, repo, branch, dir);
        if (probe.ok && probe.isDir) {
          return { type: 'hugo', postsDir: dir, imageDir: 'static/blog', imageUrlPrefix: '/blog' };
        }
      }
    }
  }
  // 11ty (Eleventy): any of eleventy.config.{js,cjs,mjs} OR .eleventy.js at root
  // AND a recognized posts directory. 11ty users put posts in varied locations
  // depending on whether they use the default input dir (.) or src/.
  for (const cfg of ['eleventy.config.js', 'eleventy.config.cjs', 'eleventy.config.mjs', '.eleventy.js']) {
    const eleventyConfig = await ghGetFile(token, owner, repo, branch, cfg);
    if (eleventyConfig.ok && eleventyConfig.exists) {
      for (const dir of ['src/posts', 'posts', 'src/content/posts', 'content/posts']) {
        const probe = await ghContentsList(token, owner, repo, branch, dir);
        if (probe.ok && probe.isDir) {
          // imageDir mirrors the posts dir's parent (src/ vs root) so passthrough
          // configs that copy src/* or static/* both have a reasonable default.
          const imageDir = dir.startsWith('src/') ? 'src/images' : 'images';
          return { type: 'eleventy', postsDir: dir, imageDir, imageUrlPrefix: '/images' };
        }
      }
    }
  }
  // Astro: astro.config.{mjs,js,ts} at root AND a content collection directory.
  // Default content collection layout puts blog posts in src/content/blog/.
  for (const cfg of ['astro.config.mjs', 'astro.config.js', 'astro.config.ts']) {
    const astroConfig = await ghGetFile(token, owner, repo, branch, cfg);
    if (astroConfig.ok && astroConfig.exists) {
      for (const dir of ['src/content/blog', 'src/content/posts', 'src/pages/blog']) {
        const probe = await ghContentsList(token, owner, repo, branch, dir);
        if (probe.ok && probe.isDir) {
          return { type: 'astro', postsDir: dir, imageDir: 'public/blog', imageUrlPrefix: '/blog' };
        }
      }
    }
  }
  return null;
}

// Light wrapper around the GH contents API that recognizes directory
// responses (array body) vs file responses (object body). ghGetFile only
// understands files, so we need this for the SSG detection probes.
async function ghContentsList(token, owner, repo, branch, dirPath) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dirPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return { ok: true, isDir: false, items: [] };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `github ${res.status} on LIST ${dirPath}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, isDir: Array.isArray(data), items: Array.isArray(data) ? data : [] };
}

// YAML-safe string for front-matter. Wraps in double quotes and escapes
// backslashes + double quotes. Newlines are preserved literally via \n.
function yamlString(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function jekyllFrontMatter({ article, brandName, imageUrl, firstPublishedAt }) {
  // Jekyll's date format: YYYY-MM-DD HH:MM:SS +0000. Strict; weird formats
  // cause Jekyll to skip the post entirely.
  const d = new Date(firstPublishedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
  const lines = [
    '---',
    `layout: post`,
    `title: ${yamlString(article.title || '')}`,
    `description: ${yamlString(article.metaDescription || '')}`,
    `date: ${dateStr}`,
    `author: ${yamlString(brandName)}`,
  ];
  if (imageUrl) lines.push(`image: ${yamlString(imageUrl)}`);
  if (article.faqs && article.faqs.length) lines.push('has_faqs: true');
  lines.push('---', '');
  return lines.join('\n');
}

function hugoFrontMatter({ article, brandName, imageUrl, firstPublishedAt, modifiedAt }) {
  const lines = [
    '---',
    `title: ${yamlString(article.title || '')}`,
    `description: ${yamlString(article.metaDescription || '')}`,
    `date: ${firstPublishedAt}`,
    `lastmod: ${modifiedAt}`,
    `draft: false`,
    `author: ${yamlString(brandName)}`,
  ];
  if (imageUrl) {
    lines.push('images:', `  - ${yamlString(imageUrl)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function eleventyFrontMatter({ article, brandName, imageUrl, firstPublishedAt }) {
  // 11ty convention is YYYY-MM-DD or full ISO date. tags drives collection
  // membership — "post" or "posts" picks up most starter templates' loops.
  const lines = [
    '---',
    `layout: post.njk`,
    `title: ${yamlString(article.title || '')}`,
    `description: ${yamlString(article.metaDescription || '')}`,
    `date: ${firstPublishedAt.slice(0, 10)}`,
    `tags:`, `  - post`, `  - posts`,
    `author: ${yamlString(brandName)}`,
  ];
  if (imageUrl) lines.push(`image: ${yamlString(imageUrl)}`);
  lines.push('---', '');
  return lines.join('\n');
}

function astroFrontMatter({ article, brandName, imageUrl, firstPublishedAt, modifiedAt }) {
  // Astro content collections frequently validate front-matter against a
  // Zod schema in src/content/config.ts. The field names below match the
  // official "blog" starter template (pubDate, updatedDate, heroImage).
  // Customers with custom schemas may need site.ssgOverride = 'none' or
  // a small follow-up to map our fields to theirs.
  const lines = [
    '---',
    `title: ${yamlString(article.title || '')}`,
    `description: ${yamlString(article.metaDescription || '')}`,
    `pubDate: ${firstPublishedAt}`,
    `updatedDate: ${modifiedAt}`,
    `author: ${yamlString(brandName)}`,
  ];
  if (imageUrl) lines.push(`heroImage: ${yamlString(imageUrl)}`);
  lines.push('---', '');
  return lines.join('\n');
}

// SSG publish: writes a content file (HTML with front-matter) into the
// generator's posts dir, commits the hero image into the static-assets dir,
// then pings IndexNow. We do NOT touch sitemap.xml or a blog index — both
// are generated by the SSG itself. The customer's existing theme owns the
// page wrapper (head, nav, footer, schema), so we provide rich front-matter
// metadata and let the theme do its thing.
async function publishSSGPost(env, site, article, ssg, token, branch) {
  const brandName = siteBrandName(site);
  const slug = article.slug;

  // 1. Hero image (if enabled). Same idempotent semantics as the standalone
  // path: only generate if no image file exists for this slug yet.
  let imageUrl = null;
  const imgMode = site.imageGeneration || 'flux';
  if (imgMode === 'flux') {
    const imgPath = `${ssg.imageDir}/${slug}.jpg`;
    const existingImg = await ghGetFile(token, site.repoOwner, site.repoName, branch, imgPath);
    if (existingImg.ok && existingImg.exists) {
      imageUrl = `${ssg.imageUrlPrefix}/${slug}.jpg`;
    } else if (existingImg.ok) {
      const img = await generateHeroImage(env, article);
      if (img.ok) {
        const imgPut = await ghPutBase64File(
          token, site.repoOwner, site.repoName, branch, imgPath, img.base64,
          `Phoenix AI: hero image for ${slug}`,
        );
        if (imgPut.ok) imageUrl = `${ssg.imageUrlPrefix}/${slug}.jpg`;
        else await audit(env, site.id, 'pipeline.image.commit_failed', { slug, error: imgPut.error });
      } else {
        await audit(env, site.id, 'pipeline.image.gen_failed', { slug, error: img.error });
      }
    }
  }

  // 2. Compose the body. Article HTML is wrapped with a hero figure when an
  // image is available, plus the FAQ block. The customer's theme will render
  // <head>/<nav>/<footer> — we don't include those.
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const heroFigure = imageUrl
    ? `<figure class="hero"><img src="${imageUrl}" alt="${escape(article.title || '')}" loading="eager" width="1280" height="720"></figure>\n\n`
    : '';
  const faqHtml = (article.faqs && article.faqs.length)
    ? '\n\n<h2>Frequently Asked Questions</h2>\n' + article.faqs.map((f) =>
        `<h3>${escape(String(f.q || ''))}</h3>\n<p>${escape(String(f.a || ''))}</p>`).join('\n')
    : '';
  const body = heroFigure + (article.html || '') + faqHtml;

  // 3. Preserved publish date (matches the standalone-HTML path semantics).
  const firstPublishedAt = await getOrInitFirstPublishedAt(env, site.id, slug, nowIso);
  const modifiedAt = nowIso();

  // 4. Front-matter + body → file at the SSG's posts dir. File extension and
  // path conventions vary by generator: Jekyll's date-prefix is strict, Astro
  // expects .md inside a content collection, 11ty and Hugo are lax.
  let postPath, frontMatter, ext;
  if (ssg.type === 'jekyll') {
    const datePrefix = firstPublishedAt.slice(0, 10);
    postPath = `${ssg.postsDir}/${datePrefix}-${slug}.html`;
    frontMatter = jekyllFrontMatter({ article, brandName, imageUrl, firstPublishedAt });
  } else if (ssg.type === 'eleventy') {
    postPath = `${ssg.postsDir}/${slug}.html`;
    frontMatter = eleventyFrontMatter({ article, brandName, imageUrl, firstPublishedAt });
  } else if (ssg.type === 'astro') {
    // Astro content collections require .md (or .mdx); .html files aren't
    // picked up by getCollection() loaders.
    postPath = `${ssg.postsDir}/${slug}.md`;
    frontMatter = astroFrontMatter({ article, brandName, imageUrl, firstPublishedAt, modifiedAt });
    ext = 'md';
  } else {
    // hugo
    postPath = `${ssg.postsDir}/${slug}.html`;
    frontMatter = hugoFrontMatter({ article, brandName, imageUrl, firstPublishedAt, modifiedAt });
  }
  const fileContent = frontMatter + body + '\n';

  const existing = await ghGetFile(token, site.repoOwner, site.repoName, branch, postPath);
  if (!existing.ok) return existing;
  const put = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, postPath, fileContent,
    `Phoenix AI: ${existing.exists ? 'update' : 'publish'} ${slug}`,
    existing.sha,
  );
  if (!put.ok) return put;

  // 5. Public URL: defaults vary by generator and are configurable. We surface
  // our best guess but flag it — the customer can correct if their permalink
  // / route config differs.
  //   Jekyll: /YYYY/MM/DD/slug.html
  //   Hugo:   /{section}/{slug}/
  //   11ty:   /posts/{slug}/ (assuming default permalink + posts collection)
  //   Astro:  /blog/{slug}/ (assuming src/content/blog/ + a [slug].astro route)
  const baseUrl = site.url.replace(/\/+$/, '');
  let publicUrl;
  if (ssg.type === 'jekyll') {
    publicUrl = `${baseUrl}/${firstPublishedAt.slice(0, 4)}/${firstPublishedAt.slice(5, 7)}/${firstPublishedAt.slice(8, 10)}/${slug}.html`;
  } else if (ssg.type === 'eleventy') {
    publicUrl = `${baseUrl}/posts/${slug}/`;
  } else if (ssg.type === 'astro') {
    publicUrl = `${baseUrl}/blog/${slug}/`;
  } else {
    publicUrl = `${baseUrl}/${ssg.postsDir.replace(/^content\//, '')}/${slug}/`;
  }
  const editUrl = `https://github.com/${site.repoOwner}/${site.repoName}/edit/${branch}/${postPath}`;

  // 6. IndexNow only — SSG handles its own sitemap.
  try {
    const key = await getOrCreateIndexNowKey(env, site);
    const keyFile = await ensureIndexNowKeyFile(token, site, branch, key);
    if (keyFile.ok) {
      const ping = await pingIndexNow({ keyHost: new URL(site.url).hostname, key, urls: [publicUrl] });
      if (ping.ok) await audit(env, site.id, 'pipeline.indexnow.pinged', { url: publicUrl, status: ping.status });
      else await audit(env, site.id, 'pipeline.indexnow.failed', { status: ping.status, error: ping.error });
    } else {
      await audit(env, site.id, 'pipeline.indexnow.key_failed', { error: keyFile.error });
    }
  } catch (err) {
    await audit(env, site.id, 'pipeline.indexnow.failed', { error: String(err.message || err).slice(0, 200) });
  }

  await audit(env, site.id, 'pipeline.ssg.published', { ssg: ssg.type, postsDir: ssg.postsDir, slug });
  return {
    ok: true,
    publicUrl,
    wpEditUrl: editUrl,
    wpPostId: null,
    imageUrl,
    indexWarning: `Published as ${ssg.type} content. Public URL is a best-guess based on default permalinks — verify after the next build completes.`,
  };
}

// Hard-delete an article we previously committed to a GitHub Pages repo:
// remove the post HTML file, remove the hero image file (if we created one),
// and rewrite the blog index with the article entry filtered out of the
// manifest. Each step is best-effort and idempotent — missing files are
// treated as success (someone may have deleted them manually).
async function githubPagesDelete(env, site, article) {
  const token = await decryptSecret(site.githubToken, env.SESSION_SECRET);
  if (!token) return { ok: false, error: 'missing GitHub PAT for this site' };
  if (!site.repoOwner || !site.repoName) return { ok: false, error: 'missing GitHub repo coordinates' };
  const branch = site.branch || 'main';
  const blogPath = site.blogPath || 'blog';

  // Same SSG routing as publish — if Jekyll/Hugo, the post file lives in a
  // different directory (and Jekyll uses a date-prefixed filename), so we
  // hand off to the SSG-aware delete adapter. Without this branch, delete
  // requests on SSG-published posts silently miss the file.
  if (site.ssgOverride !== 'none') {
    const ssg = site.ssgOverride && site.ssgOverride !== 'auto'
      ? presetSSG(site.ssgOverride)
      : await detectGithubPagesSSG(token, site.repoOwner, site.repoName, branch);
    if (ssg) return deleteSSGPost(env, site, article, ssg, token, branch);
  }

  const results = {};

  // 1. Delete the post file.
  const postPath = `${blogPath}/${article.slug}.html`;
  const postFile = await ghGetFile(token, site.repoOwner, site.repoName, branch, postPath);
  if (postFile.ok && postFile.exists) {
    results.post = await ghDeleteFile(
      token, site.repoOwner, site.repoName, branch, postPath, postFile.sha,
      `Phoenix AI: delete ${article.slug}`,
    );
  } else {
    results.post = { ok: true, alreadyGone: true };
  }

  // 2. Delete the hero image file (if the post had one). Path stored on the
  // article record at publish time as imageUrl, leading slash.
  if (article.imageUrl) {
    const imgPath = article.imageUrl.replace(/^\//, '');
    const imgFile = await ghGetFile(token, site.repoOwner, site.repoName, branch, imgPath);
    if (imgFile.ok && imgFile.exists) {
      results.image = await ghDeleteFile(
        token, site.repoOwner, site.repoName, branch, imgPath, imgFile.sha,
        `Phoenix AI: delete image for ${article.slug}`,
      );
    } else {
      results.image = { ok: true, alreadyGone: true };
    }
  }

  // 3. Rewrite the blog index without this article in the manifest.
  const indexPath = `${blogPath}/index.html`;
  const idx = await ghGetFile(token, site.repoOwner, site.repoName, branch, indexPath);
  if (idx.ok && idx.exists) {
    const prev = parseIndexManifest(idx.content);
    const filtered = prev.filter((a) => a.slug !== article.slug);
    // Only rewrite if the manifest actually changed; avoids a no-op commit
    // when the article being deleted was never in the index (drafts).
    if (filtered.length !== prev.length) {
      const inject = injectArticleList({
        existingHtml: idx.content,
        exists: true,
        site,
        articles: filtered,
      });
      if (inject.skipped) {
        // Hand-curated index without markers — we never touched it on publish,
        // so we don't touch it on delete either. The post file and image are
        // already gone above; the only thing left is whatever stale link the
        // customer manually added to their curated cards (which we can't know
        // about). Surface this back to the caller so the dashboard banner can
        // mention it.
        results.index = { ok: true, skipped: true, reason: inject.reason };
      } else {
        results.index = await ghPutFile(
          token, site.repoOwner, site.repoName, branch, indexPath, inject.html,
          `Phoenix AI: remove ${article.slug} from index`,
          idx.sha,
        );
      }
    } else {
      results.index = { ok: true, unchanged: true };
    }
  }

  // Clear the slug→first-publish KV entry so a future republish of the same
  // slug starts with a fresh datePublished instead of inheriting the old one.
  await env.ARTICLES.delete(`firstpub:${site.id}:${article.slug}`).catch(() => {});

  const allOk = Object.values(results).every((r) => r.ok);
  return allOk ? { ok: true, results } : { ok: false, error: 'partial delete', results };
}

// SSG-aware delete: removes the front-matter post file from the generator's
// posts dir and the hero image from the static-assets dir. No blog index
// rewrite — the SSG's auto-generated archive/RSS will drop the post on its
// next build. The slug→first-publish KV entry is also cleared so a future
// republish gets a fresh date.
async function deleteSSGPost(env, site, article, ssg, token, branch) {
  const slug = article.slug;
  const results = {};

  // 1. Post file. Filename + extension vary by SSG and must mirror the
  // publish-side choices in publishSSGPost.
  let postPath;
  if (ssg.type === 'jekyll') {
    const firstPub = await env.ARTICLES.get(`firstpub:${site.id}:${slug}`);
    const datePrefix = (firstPub || nowIso()).slice(0, 10);
    postPath = `${ssg.postsDir}/${datePrefix}-${slug}.html`;
  } else if (ssg.type === 'astro') {
    postPath = `${ssg.postsDir}/${slug}.md`;
  } else {
    postPath = `${ssg.postsDir}/${slug}.html`;
  }
  const postFile = await ghGetFile(token, site.repoOwner, site.repoName, branch, postPath);
  if (postFile.ok && postFile.exists) {
    results.post = await ghDeleteFile(
      token, site.repoOwner, site.repoName, branch, postPath, postFile.sha,
      `Phoenix AI: delete ${slug}`,
    );
  } else {
    results.post = { ok: true, alreadyGone: true };
  }

  // 2. Hero image. Computed from ssg.imageDir + slug because Hugo's
  // URL-served path (/blog/slug.jpg) differs from the disk path
  // (static/blog/slug.jpg), so article.imageUrl can't be used directly.
  const imgPath = `${ssg.imageDir}/${slug}.jpg`;
  const imgFile = await ghGetFile(token, site.repoOwner, site.repoName, branch, imgPath);
  if (imgFile.ok && imgFile.exists) {
    results.image = await ghDeleteFile(
      token, site.repoOwner, site.repoName, branch, imgPath, imgFile.sha,
      `Phoenix AI: delete image for ${slug}`,
    );
  } else {
    results.image = { ok: true, alreadyGone: true };
  }

  // 3. Clear KV entry so future republish gets a fresh first-publish date.
  await env.ARTICLES.delete(`firstpub:${site.id}:${slug}`).catch(() => {});

  await audit(env, site.id, 'pipeline.ssg.deleted', { ssg: ssg.type, slug, postPath });

  const allOk = Object.values(results).every((r) => r.ok);
  return allOk ? { ok: true, results } : { ok: false, error: 'partial delete', results };
}

// ──────────────────────────────────────────────────────────────
// Site-chrome bootstrap (github-pages, non-SSG sites).
//
// For plain-HTML github-pages sites that don't already use our
// site-chrome convention, scrape their homepage, lift out the header +
// footer markup, and commit a starter assets/site-chrome.{css,js} pair
// to their repo. Generated posts then inherit the customer's nav and
// footer for free — no more orphaned-looking blog pages.
//
// Approach: the generated site-chrome.js injects the customer's own
// external stylesheets PLUS the extracted header/footer HTML into our
// blog-post placeholders. Because the same CSS is loaded, the nav
// inherits the customer's real styling without us having to copy or
// reproduce their CSS rules. Relative URLs in the markup keep working
// since the blog post is served from the same domain.

const CHROME_CSS_PATH = 'assets/site-chrome.css';
const CHROME_JS_PATH = 'assets/site-chrome.js';

async function extractSiteChromeFromHomepage(siteUrl) {
  let res;
  try {
    res = await fetch(siteUrl, {
      headers: { 'User-Agent': 'PhoenixAI/1.0 (+https://phoenixmethodseo.com/phoenix-ai/)' },
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err.message || err).slice(0, 200)}` };
  }
  if (!res.ok) return { ok: false, error: `homepage returned ${res.status}` };
  const html = await res.text();

  // First <header>...</header> and last <footer>...</footer>. Regex is
  // fragile in general but for top-level structural elements it's reliable
  // enough on real sites, and we don't need a full DOM parser just for this.
  const headerMatch = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i);
  const headerHtml = headerMatch ? headerMatch[0] : '';

  // Use lastIndexOf-style approach for footer: match all, take last.
  const footerMatches = [...html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gi)];
  const footerHtml = footerMatches.length ? footerMatches[footerMatches.length - 1][0] : '';

  // External stylesheets — resolve to absolute URLs so they load correctly
  // when injected into a blog-post page served from a different path.
  const stylesheetUrls = [];
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi)) {
    const hrefMatch = m[0].match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    try {
      stylesheetUrls.push(new URL(hrefMatch[1], siteUrl).href);
    } catch { /* skip malformed */ }
  }

  // <body> classes (some themes scope all styles to body class).
  const bodyMatch = html.match(/<body\b([^>]*)>/i);
  const bodyClassMatch = bodyMatch && bodyMatch[1].match(/\bclass=["']([^"']+)["']/i);
  const bodyClass = bodyClassMatch ? bodyClassMatch[1] : '';

  return { ok: true, headerHtml, footerHtml, stylesheetUrls, bodyClass };
}

function generateSiteChromeFiles({ chrome, siteUrl }) {
  // CSS is intentionally minimal — we don't try to replicate the customer's
  // styles. Their own stylesheets get injected at runtime by the JS file and
  // the extracted nav/footer markup inherits from those. We just ensure the
  // injection points don't collapse to zero height before JS runs and the
  // article body has some readable defaults if the customer has no CSS at
  // all (unlikely but possible).
  const css = `/* Phoenix AI: site-chrome bootstrap. Generated from ${siteUrl}.
 * Safe to edit — re-bootstrap will not overwrite this file.
 */
#pm-nav, #pm-footer { display: block; }
#pm-nav:empty, #pm-footer:empty { display: none; }
.blog-post { max-width: 720px; margin: 60px auto; padding: 0 24px; line-height: 1.7; }
.blog-post h1, .blog-post h2, .blog-post h3 { line-height: 1.25; }
.blog-post .hero img { width: 100%; height: auto; border-radius: 12px; display: block; margin-bottom: 28px; }
`;

  const headerJson = JSON.stringify(chrome.headerHtml || '');
  const footerJson = JSON.stringify(chrome.footerHtml || '');
  const sheetsJson = JSON.stringify(chrome.stylesheetUrls || []);
  const bodyClassJson = JSON.stringify(chrome.bodyClass || '');

  const js = `/* Phoenix AI: site-chrome bootstrap. Generated from ${siteUrl}.
 * Injects the customer's own stylesheets + extracted header/footer markup
 * so blog posts inherit the live site's design. Safe to edit — re-bootstrap
 * will not overwrite this file.
 */
(function () {
  var sheets = ${sheetsJson};
  var headerHtml = ${headerJson};
  var footerHtml = ${footerJson};
  var bodyClass = ${bodyClassJson};

  // Load the customer's stylesheets (idempotent — skip ones already on the page).
  var existingHrefs = new Set(
    Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(function (l) { return l.href; })
  );
  sheets.forEach(function (href) {
    if (existingHrefs.has(href)) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  });

  // Apply body classes if the customer's theme scopes styles to them.
  if (bodyClass && document.body) {
    bodyClass.split(/\\s+/).filter(Boolean).forEach(function (c) {
      if (!document.body.classList.contains(c)) document.body.classList.add(c);
    });
  }

  // Inject nav/footer into the Phoenix AI placeholders.
  function inject() {
    var navMount = document.getElementById('pm-nav');
    if (navMount && !navMount.firstChild && headerHtml) navMount.innerHTML = headerHtml;
    var footMount = document.getElementById('pm-footer');
    if (footMount && !footMount.firstChild && footerHtml) footMount.innerHTML = footerHtml;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
`;

  return { css, js };
}

async function bootstrapSiteChrome(env, site, opts = {}) {
  if (site.cms !== 'github-pages') return { ok: false, error: 'bootstrap-chrome only applies to github-pages sites' };
  const token = await decryptSecret(site.githubToken, env.SESSION_SECRET);
  if (!token) return { ok: false, error: 'missing GitHub PAT for this site' };
  if (!site.repoOwner || !site.repoName) return { ok: false, error: 'missing GitHub repo coordinates' };
  const branch = site.branch || 'main';

  // Idempotency: if either file already exists, do not overwrite. The
  // customer may have hand-tuned them; clobbering would lose their edits.
  // opts.force = true lets the customer explicitly re-bootstrap.
  const existingCss = await ghGetFile(token, site.repoOwner, site.repoName, branch, CHROME_CSS_PATH);
  const existingJs = await ghGetFile(token, site.repoOwner, site.repoName, branch, CHROME_JS_PATH);
  if (!existingCss.ok) return existingCss;
  if (!existingJs.ok) return existingJs;
  if (!opts.force && (existingCss.exists || existingJs.exists)) {
    return { ok: false, error: 'site-chrome.css and/or site-chrome.js already exist. Pass force=true to overwrite.', alreadyExists: true };
  }

  const chrome = await extractSiteChromeFromHomepage(site.url);
  if (!chrome.ok) return chrome;

  // If we couldn't find a header AND a footer AND any stylesheets, the
  // homepage probably isn't structured how we expect — bail rather than
  // commit empty chrome files.
  if (!chrome.headerHtml && !chrome.footerHtml && (!chrome.stylesheetUrls || !chrome.stylesheetUrls.length)) {
    return { ok: false, error: 'could not extract usable nav/footer/styles from the homepage. Site may use a JS-only framework or non-standard markup.' };
  }

  const files = generateSiteChromeFiles({ chrome, siteUrl: site.url });

  const cssPut = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, CHROME_CSS_PATH, files.css,
    'Phoenix AI: bootstrap site-chrome.css', existingCss.sha,
  );
  if (!cssPut.ok) return cssPut;

  const jsPut = await ghPutFile(
    token, site.repoOwner, site.repoName, branch, CHROME_JS_PATH, files.js,
    'Phoenix AI: bootstrap site-chrome.js', existingJs.sha,
  );
  if (!jsPut.ok) return jsPut;

  await audit(env, site.id, 'site.chrome.bootstrapped', {
    headerChars: (chrome.headerHtml || '').length,
    footerChars: (chrome.footerHtml || '').length,
    stylesheets: (chrome.stylesheetUrls || []).length,
    force: Boolean(opts.force),
  });

  return {
    ok: true,
    extracted: {
      header: Boolean(chrome.headerHtml),
      footer: Boolean(chrome.footerHtml),
      stylesheets: (chrome.stylesheetUrls || []).length,
      bodyClass: chrome.bodyClass || '',
    },
    files: { css: CHROME_CSS_PATH, js: CHROME_JS_PATH },
  };
}

// ──────────────────────────────────────────────────────────────
// Job runner. Manual /generate awaits this inline (so the full request
// wall-time window is available — ctx.waitUntil was being cancelled on
// Workers Free before the LLM finished). Cron-driven generation still
// fires runPipelineJob via ctx.waitUntil since scheduled handlers get
// their own time budget separate from fetch handlers.
//
// Job state lives in the ARTICLES KV under prefix job:<jobId>. TTL is 1h
// — enough for the dashboard to surface success/failure, then auto-expires
// so the namespace doesn't accumulate stale records.

const JOB_TTL_SECONDS = 3600;

async function saveJob(env, job) {
  await env.ARTICLES.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

async function getJob(env, jobId) {
  const raw = await env.ARTICLES.get(`job:${jobId}`);
  return raw ? JSON.parse(raw) : null;
}

// runPipelineJob wraps runPipeline with status updates. Safe to call from
// ctx.waitUntil() — never throws (errors are captured into the job record).
async function runPipelineJob(env, site, jobId, opts = {}) {
  try {
    await saveJob(env, { id: jobId, siteId: site.id, status: 'generating', queuedAt: opts.queuedAt || nowIso(), startedAt: nowIso() });
    const result = await runPipeline(env, site, opts);
    if (result.ok) {
      await saveJob(env, {
        id: jobId, siteId: site.id, status: 'done',
        queuedAt: opts.queuedAt || nowIso(), startedAt: nowIso(), finishedAt: nowIso(),
        articleId: result.article && result.article.id,
        indexWarning: result.article && result.article.indexWarning,
      });
    } else {
      await saveJob(env, {
        id: jobId, siteId: site.id, status: 'failed',
        queuedAt: opts.queuedAt || nowIso(), startedAt: nowIso(), finishedAt: nowIso(),
        error: result.error || 'unknown error',
      });
    }
  } catch (err) {
    // Belt-and-suspenders — runPipeline shouldn't throw, but if it does,
    // we still want a job record so the dashboard can show something useful.
    await saveJob(env, {
      id: jobId, siteId: site.id, status: 'failed',
      queuedAt: opts.queuedAt || nowIso(), startedAt: nowIso(), finishedAt: nowIso(),
      error: `unhandled exception: ${String(err.message || err).slice(0, 300)}`,
    });
  }
}

// ──────────────────────────────────────────────────────────────
// Pipeline: full run

async function runPipeline(env, site, opts = {}) {
  const startedAt = nowIso();
  await audit(env, site.id, 'pipeline.start', { manual: Boolean(opts.manual), explicit: Boolean(opts.keyword) });

  // 1. Make sure we have keywords to pick from — unless the caller passed
  // an explicit keyword override (PM-264), in which case the lookup +
  // mark-picked already happened at the route layer.
  if (!opts.keyword) {
    let kwListRaw = await env.KEYWORDS.get(`kws:${site.id}`);
    let kwList = kwListRaw ? JSON.parse(kwListRaw) : [];
    if (!kwList.length || kwList.every((k) => k.picked)) {
      const refreshed = await researchAndStoreKeywords(env, site);
      kwList = refreshed.list;
    }
  }

  // 2. Pick the next keyword (or use the explicit override).
  const keyword = opts.keyword || await pickNextKeyword(env, site.id);
  if (!keyword) {
    await audit(env, site.id, 'pipeline.error', { reason: 'no keywords available' });
    return { ok: false, error: 'No keywords available for this site.' };
  }

  // 3. Generate article via the LLM. Pull the customer's existing posts
  // first so the LLM can weave in 2-4 internal links (real URLs only — we
  // validate every <a href> in the output against this list and unwrap any
  // hallucinated ones). Also build a SERP brief (PM-280) — top-10 ranking
  // pages for this keyword, their median word count, common H2 themes — so
  // the writer covers the terrain Google already rewards. Brief is best-
  // effort: no Ahrefs key or all-failed-fetches → null → prompt omits the
  // section and ships the article anyway.
  const internalLinks = await fetchInternalLinkTargets(env, site);
  let serpBrief = null;
  try {
    const customerForBrief = site.ownerEmail ? await getOrCreateCustomer(env, site.ownerEmail) : null;
    const briefKey = await resolveAhrefsKey(env, customerForBrief);
    if (briefKey) {
      serpBrief = await buildSerpBrief(env, keyword.keyword, site.country || 'us', briefKey);
      await audit(env, site.id, 'pipeline.serp_brief', {
        keyword: keyword.keyword,
        pagesAnalyzed: serpBrief?.pagesAnalyzed || 0,
        medianWords: serpBrief?.medianWordCount || null,
        h2Themes: serpBrief?.commonH2Themes.length || 0,
      });
    }
  } catch (err) {
    // Brief failures must never block article generation. Log and proceed.
    await audit(env, site.id, 'pipeline.serp_brief.error', { error: String(err.message || err).slice(0, 200) });
  }
  const prompt = buildArticlePrompt({ keyword, site, internalLinks, serpBrief });
  const llmResult = await callLLM(env, site, prompt);
  if (!llmResult.ok) {
    await audit(env, site.id, 'pipeline.error', { stage: 'llm', error: llmResult.error });
    return { ok: false, error: llmResult.error };
  }
  const article = llmResult.content;

  // 3a. Multi-pass writing (PM-281): if the site has `multiPass` enabled and
  // we have a SERP brief, run a critique → revise loop on the draft. The
  // orchestrator is fully best-effort — any failure path returns the
  // original article unchanged, so this never makes quality worse.
  if (article && typeof article.html === 'string') {
    try {
      const mp = await runMultiPass(env, site, article, keyword, serpBrief);
      if (mp.sectionsRevised > 0) article.html = mp.html;
      await audit(env, site.id, 'pipeline.multipass', {
        skipped: mp.skipped || null,
        initialScore: mp.initialScore,
        finalScore: mp.finalScore,
        sectionsRequested: mp.sectionsRequested,
        sectionsRevised: mp.sectionsRevised,
      });
    } catch (err) {
      await audit(env, site.id, 'pipeline.multipass.error', { error: String(err.message || err).slice(0, 200) });
    }
  }

  // 3b. Fact-check pass (PM-282): if the site has `factCheck` enabled, score
  // every factual claim in the final article body. Low-confidence claims get
  // wrapped inline with <mark class="pm-fact-flag"> so the operator sees
  // them highlighted on the approval page. YMYL safety lever — articles
  // still ship through the existing approval workflow, just with the
  // questionable sentences visually flagged.
  if (article && typeof article.html === 'string') {
    try {
      const fc = await runFactCheck(env, site, article, keyword);
      if (fc.annotated > 0) article.html = fc.html;
      await audit(env, site.id, 'pipeline.fact_check', {
        skipped: fc.skipped || null,
        claimsFound: fc.claimsFound,
        lowConfidence: fc.lowConfidence,
        annotated: fc.annotated,
        byType: fc.byType,
      });
    } catch (err) {
      await audit(env, site.id, 'pipeline.fact_check.error', { error: String(err.message || err).slice(0, 200) });
    }
  }

  if (article && typeof article.html === 'string') {
    const allowedUrls = internalLinks.map((l) => l.url);
    const linkCheck = validateInternalLinks(article.html, site, allowedUrls);
    article.html = linkCheck.html;
    await audit(env, site.id, 'pipeline.internal_links', {
      total: linkCheck.total, kept: linkCheck.kept, stripped: linkCheck.stripped,
      available: allowedUrls.length,
    });
  }

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
    indexWarning: wpResult.indexWarning || null,
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

    if (path.startsWith('/api/')) return cors(await apiRouter(request, env, url, path, ctx), request);

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
    // Phase 2 entry point: walk every active site and spawn an async job per
    // site. Sites generate in parallel via ctx.waitUntil() — the cron itself
    // returns within a few seconds; each generation continues running for as
    // long as it needs to (up to the worker's wall-clock limit). Job records
    // are written to KV the same way the manual generate endpoint does, so
    // any future dashboard widget can surface daily-cron status by reading
    // job:* keys directly.
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
      const jobId = uuid();
      const queuedAt = nowIso();
      await saveJob(env, { id: jobId, siteId: site.id, status: 'queued', queuedAt, source: 'cron' });
      ctx.waitUntil(runPipelineJob(env, site, jobId, { manual: false, queuedAt }));
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

async function apiRouter(request, env, url, path, ctx) {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const email = session.email;

  if (path === '/api/me' && request.method === 'GET') {
    const customer = await getOrCreateCustomer(env, email);
    const sites = await listSitesForOwner(env, email);
    // Resolve effective fields here so the frontend doesn't have to duplicate
    // default-fallback / plan-inference logic. PM-271 also strips the encrypted
    // ahrefsApiKey blob and exposes derived booleans the SPA can gate on.
    const plan = customerPlan(customer);
    const hasAhrefsKey = Boolean(customer.ahrefsApiKey);
    const systemAhrefs = canUseSystemAhrefs(customer);
    const { ahrefsApiKey: _omit, ...safeCustomer } = customer;
    return json({
      customer: {
        ...safeCustomer,
        plan,
        siteLimit: siteLimitFor(customer),
        hasAhrefsKey,
        canUseSystemAhrefs: systemAhrefs,
        canUseAhrefs: hasAhrefsKey || systemAhrefs,
      },
      sites,
    });
  }

  // PM-271: PATCH /api/me — for now, the only editable field is the BYOK
  // Ahrefs API key. Pass an empty string to clear. The key is AES-encrypted
  // before storage; the GET response never includes the encrypted blob.
  if (path === '/api/me' && request.method === 'PATCH') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    const customer = await getOrCreateCustomer(env, email);
    if (typeof body.ahrefsApiKey === 'string') {
      const trimmed = body.ahrefsApiKey.trim();
      customer.ahrefsApiKey = trimmed ? await encryptSecret(trimmed, env.SESSION_SECRET) : '';
      await env.CUSTOMERS.put(email, JSON.stringify(customer));
      await audit(env, `customer:${email}`, trimmed ? 'customer.ahrefs_key.set' : 'customer.ahrefs_key.cleared', {});
    }
    const plan = customerPlan(customer);
    const hasAhrefsKey = Boolean(customer.ahrefsApiKey);
    const systemAhrefs = canUseSystemAhrefs(customer);
    const { ahrefsApiKey: _omit, ...safeCustomer } = customer;
    return json({
      ok: true,
      customer: {
        ...safeCustomer,
        plan,
        siteLimit: siteLimitFor(customer),
        hasAhrefsKey,
        canUseSystemAhrefs: systemAhrefs,
        canUseAhrefs: hasAhrefsKey || systemAhrefs,
      },
    });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([a-z0-9-]+)$/i);
  if (jobMatch && request.method === 'GET') {
    const job = await getJob(env, jobMatch[1]);
    if (!job) return json({ error: 'not found' }, 404);
    // Authz: the job must belong to a site this user owns.
    const site = await getSite(env, job.siteId);
    if (!site || site.ownerEmail !== email) return json({ error: 'unauthorized' }, 403);
    return json({ job });
  }

  if (path === '/api/sites' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    // Per-site billing gate. Each customer gets siteLimit sites; default 1
    // until billing portal is live. Enforced server-side so it can't be
    // bypassed by curling the API directly.
    const customer = await getOrCreateCustomer(env, email);
    const existingSites = await listSitesForOwner(env, email);
    const limit = siteLimitFor(customer);
    if (existingSites.length >= limit) {
      return json({
        error: 'site limit reached',
        message: `Your plan includes ${limit} site${limit === 1 ? '' : 's'}. To add more, email hello@phoenixmethodseo.com — pricing is per-site per month.`,
        currentCount: existingSites.length,
        limit,
      }, 402);
    }
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
    const keywordSource = ['gsc', 'ahrefs', 'serpbear', 'manual'].includes(body.keywordSource) ? body.keywordSource : 'gsc';
    // PM-271: server-side Ahrefs eligibility gate. The SPA disables the radio
    // for ineligible customers, but the API has to enforce it too in case of
    // direct curl or stale UI state.
    if (keywordSource === 'ahrefs' && !customer.ahrefsApiKey && !canUseSystemAhrefs(customer)) {
      return json({ error: 'Ahrefs source requires Pro plan or your own Ahrefs API key. Add a key in Account settings, then connect this site.' }, 403);
    }
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
      keywordFilter: 'auto',
      serpBearUrl: '',
      serpBearApiKey: '',
      serpBearDomain: '',
      niche: learned.niche,
      brandVoice: learned.brandVoice,
      brandVoiceOverride,
      autoPublish: false,
      requireApproval,
      keywordSource,
      gsc: null,
      manualKeywords: Array.isArray(body.manualKeywords) ? body.manualKeywords.slice(0, 50) : [],
      keywordBlocklist: [],
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
      if (typeof body.brandName === 'string') {
        // Empty string clears the override (we fall back to hostname-derived).
        site.brandName = body.brandName.trim().slice(0, 80);
      }
      if (typeof body.brandVoiceOverride === 'string') {
        site.brandVoiceOverride = body.brandVoiceOverride.trim().slice(0, 4000);
      }
      if (typeof body.requireApproval === 'boolean') site.requireApproval = body.requireApproval;
      if (typeof body.autoPublish === 'boolean') {
        // Honor the lock — can't flip autoPublish on while requireApproval is true.
        site.autoPublish = site.requireApproval ? false : body.autoPublish;
      }
      if (['gsc', 'ahrefs', 'serpbear', 'manual'].includes(body.keywordSource)) {
        // PM-271: same Ahrefs gate as the POST handler — UI disables the radio
        // for ineligible customers but the API enforces it server-side too.
        if (body.keywordSource === 'ahrefs') {
          const customer = await getOrCreateCustomer(env, email);
          if (!customer.ahrefsApiKey && !canUseSystemAhrefs(customer)) {
            return json({ error: 'Ahrefs source requires Pro plan or your own Ahrefs API key. Add a key in Account settings first.' }, 403);
          }
        }
        site.keywordSource = body.keywordSource;
      }
      // SerpBear connection fields. URL + domain are public values; API key is the only secret.
      if (typeof body.serpBearUrl === 'string') site.serpBearUrl = body.serpBearUrl.trim().replace(/\/+$/, '');
      if (typeof body.serpBearDomain === 'string') site.serpBearDomain = body.serpBearDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (typeof body.serpBearApiKey === 'string') {
        const trimmed = body.serpBearApiKey.trim();
        site.serpBearApiKey = trimmed ? await encryptSecret(trimmed, env.SESSION_SECRET) : '';
      }
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
      if (['auto', 'off'].includes(body.keywordFilter)) site.keywordFilter = body.keywordFilter;
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
        if (['auto', 'jekyll', 'hugo', 'eleventy', 'astro', 'none'].includes(body.ssgOverride)) {
          // 'auto' is the default — store as empty so the publish-side check
          // (`site.ssgOverride !== 'none'` + override fallback to detection)
          // works the same for both unset and explicitly-auto sites.
          site.ssgOverride = body.ssgOverride === 'auto' ? '' : body.ssgOverride;
        }
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
      return json({ ok: true, count: result.list.length, keywords: result.list, source: result.source, seedKind: result.seedKind });
    }

    if (sub === 'bootstrap-chrome' && request.method === 'POST') {
      // Scrapes the customer's homepage and commits a starter
      // assets/site-chrome.{css,js} pair to their github-pages repo so
      // future blog posts inherit their real nav/footer/styles. No-op
      // (HTTP 409) if either file already exists; pass { force: true }
      // in the body to overwrite.
      if (site.cms !== 'github-pages') return json({ error: 'bootstrap-chrome only applies to github-pages sites' }, 400);
      let body = {};
      try { body = await request.json(); } catch { /* empty body fine */ }
      const result = await bootstrapSiteChrome(env, site, { force: Boolean(body && body.force) });
      if (!result.ok) return json(result, result.alreadyExists ? 409 : 400);
      return json(result);
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

    // PM-263: remove a keyword from the chip list AND add it to the persistent
    // per-site blocklist so research never re-suggests it. Lowercased on both
    // store and compare so casing variants collapse.
    if (sub === 'keywords/remove' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const keyword = String(body.keyword || '').trim().toLowerCase();
      if (!keyword) return json({ error: 'keyword required' }, 400);
      const blocklist = Array.isArray(site.keywordBlocklist) ? site.keywordBlocklist.slice() : [];
      if (!blocklist.includes(keyword)) blocklist.unshift(keyword);
      site.keywordBlocklist = blocklist.slice(0, 200);
      await saveSite(env, site);
      const rawList = await env.KEYWORDS.get(`kws:${siteId}`);
      const list = rawList ? JSON.parse(rawList) : [];
      const next = list.filter((k) => String(k.keyword || '').toLowerCase().trim() !== keyword);
      await env.KEYWORDS.put(`kws:${siteId}`, JSON.stringify(next));
      await audit(env, siteId, 'keywords.removed', { keyword, blocklistSize: site.keywordBlocklist.length });
      return json({ ok: true, keywords: next, blocklist: site.keywordBlocklist });
    }

    if (sub === 'generate' && request.method === 'POST') {
      // Runs the pipeline synchronously inside the request. ctx.waitUntil()
      // was being cancelled on the Workers Free plan before the LLM + publish
      // steps could finish (only a few seconds of post-response budget), so
      // jobs silently died and the dashboard's poll never saw 'done' or
      // 'failed'. Awaiting directly uses the full request wall-time window
      // instead. Job state is still written to KV so the existing polling
      // loop keeps working unchanged — the first poll just sees the final
      // status immediately.
      //
      // PM-264: optional body { keyword } lets the customer pick which
      // keyword to write on (from a chip). When provided, we validate it's
      // in the queue and not rejected, mark it picked here, and pass it
      // to the pipeline so pickNextKeyword is bypassed.
      let keywordOverride = null;
      let body = null;
      try { body = await request.json(); } catch { /* empty body is fine — falls back to auto-pick */ }
      if (body && typeof body.keyword === 'string' && body.keyword.trim()) {
        const wanted = body.keyword.trim().toLowerCase();
        const rawList = await env.KEYWORDS.get(`kws:${siteId}`);
        const list = rawList ? JSON.parse(rawList) : [];
        const target = list.find((k) => String(k.keyword || '').toLowerCase().trim() === wanted);
        if (!target) return json({ error: "That keyword isn't in this site's queue. Refresh keywords and try again." }, 400);
        if (target.rejected) return json({ error: 'That keyword is marked off-niche. Pick a different one.' }, 400);
        target.picked = true;
        target.pickedAt = nowIso();
        await env.KEYWORDS.put(`kws:${siteId}`, JSON.stringify(list));
        keywordOverride = target;
      }
      const jobId = uuid();
      const queuedAt = nowIso();
      await saveJob(env, { id: jobId, siteId, status: 'queued', queuedAt });
      await runPipelineJob(env, site, jobId, { manual: true, queuedAt, keyword: keywordOverride });
      const finalJob = await getJob(env, jobId);
      return json({
        ok: true,
        jobId,
        status: finalJob ? finalJob.status : 'done',
        keyword: keywordOverride ? keywordOverride.keyword : null,
      });
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

    if (articleMatch && request.method === 'DELETE') {
      const articleId = articleMatch[1];
      const raw = await env.ARTICLES.get(`art:${siteId}:${articleId}`);
      if (!raw) return json({ error: 'not found' }, 404);
      const article = JSON.parse(raw);

      // If the article was published to a destination CMS, try to remove it
      // from there too. CMS failure does NOT block the local delete — the
      // customer wants it gone from Phoenix AI either way and can manually
      // clean up the destination side if our automated delete failed.
      let cmsDelete = { ok: true, skipped: true };
      const wasPublished = article.status === 'publish' || article.publishedAt;
      if (wasPublished) {
        if (site.cms === 'wordpress' && article.wpPostId) {
          cmsDelete = await wpDelete(env, site, article.wpPostId);
        } else if (site.cms === 'github-pages') {
          cmsDelete = await githubPagesDelete(env, site, article);
        }
      }

      // Always remove from our KV (both the article record and the index entry).
      await env.ARTICLES.delete(`art:${siteId}:${articleId}`);
      const indexRaw = await env.ARTICLES.get(`list:${siteId}`);
      const ids = indexRaw ? JSON.parse(indexRaw) : [];
      await env.ARTICLES.put(`list:${siteId}`, JSON.stringify(ids.filter((id) => id !== articleId)));
      await audit(env, siteId, 'article.deleted', { articleId, slug: article.slug, wasPublished, cmsDelete });
      return json({ ok: true, cmsDelete });
    }

    // POST /api/sites/:siteId/articles/:articleId/publish — flip a draft to
    // published. Idempotent: already-published articles return their existing
    // record without re-publishing. Failure path keeps the article as a draft
    // with the new publishError surfaced.
    const publishMatch = sub.match(/^articles\/([a-z0-9-]+)\/publish$/i);
    if (publishMatch && request.method === 'POST') {
      const articleId = publishMatch[1];
      const raw = await env.ARTICLES.get(`art:${siteId}:${articleId}`);
      if (!raw) return json({ error: 'not found' }, 404);
      const article = JSON.parse(raw);
      if (article.status === 'publish' || article.status === 'ready') {
        return json({ ok: true, article, alreadyPublished: true });
      }
      let publishResult;
      if (site.cms === 'manual') {
        publishResult = { ok: true };
        article.status = 'ready';
      } else if (site.cms === 'github-pages') {
        publishResult = await githubPagesPublish(env, site, article, 'publish');
        if (publishResult.ok) article.status = 'publish';
      } else {
        publishResult = await wpPublish(env, site, article, 'publish');
        if (publishResult.ok) article.status = 'publish';
      }
      if (publishResult.ok) {
        article.publicUrl = publishResult.publicUrl || article.publicUrl;
        article.wpEditUrl = publishResult.wpEditUrl || article.wpEditUrl;
        article.wpPostId = publishResult.wpPostId || article.wpPostId;
        article.imageUrl = publishResult.imageUrl || article.imageUrl;
        article.indexWarning = publishResult.indexWarning || null;
        article.publishError = null;
        article.publishedAt = nowIso();
      } else {
        article.publishError = publishResult.error || 'unknown publish error';
      }
      await env.ARTICLES.put(`art:${siteId}:${articleId}`, JSON.stringify(article));
      await audit(env, siteId, 'article.publish', {
        articleId, slug: article.slug, cms: site.cms,
        ok: publishResult.ok, error: publishResult.error,
      });
      return publishResult.ok
        ? json({ ok: true, article })
        : json({ ok: false, error: publishResult.error, article }, 500);
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
  .panel table td.actions-cell { max-width: none; word-break: normal; overflow-wrap: normal; }
  .panel pre, .panel code { white-space: pre-wrap; word-break: break-all; }
  .panel .site-meta { word-break: break-word; }
  .row-actions { flex-wrap: wrap; }
  textarea, input[type=text], input[type=url], input[type=password], input[type=email] { max-width: 100%; }
  .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.88rem; letter-spacing: 0.1em; text-transform: uppercase; border: none; cursor: pointer; transition: transform .15s, box-shadow .2s; white-space: nowrap; }
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
  table th, table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table th { font-family: 'Rajdhani', sans-serif; font-size: 0.74rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--deep); font-weight: 600; }
  table tr:last-child td { border-bottom: none; }
  /* Article-row actions cell: each action is a pill that never breaks
     mid-word; cells wrap as a flex container instead of inline text. */
  td.actions-cell { white-space: normal; max-width: none; }
  td.actions-cell .actions { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  td.actions-cell .actions > * { white-space: nowrap; display: inline-flex; align-items: center; }
  td.actions-cell .actions .action-sep { color: var(--border); user-select: none; }
  .keyword-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px 4px 12px; margin: 3px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; font-size: 0.82rem; }
  .keyword-chip.picked { opacity: 0.5; text-decoration: line-through; }
  .keyword-chip-text { line-height: 1.4; }
  .keyword-chip-remove { background: none; border: none; color: var(--deep); cursor: pointer; padding: 0 2px; font-size: 1.05rem; line-height: 1; opacity: 0.55; transition: opacity 0.15s ease, color 0.15s ease; }
  .keyword-chip-remove:hover { opacity: 1; color: var(--danger); }
  .keyword-chip-remove:disabled { opacity: 0.3; cursor: wait; }
  .keyword-chip-action { background: none; border: none; color: var(--fire-m); cursor: pointer; padding: 0 4px; font-size: 0.72rem; line-height: 1; font-family: 'Rajdhani', sans-serif; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; opacity: 0.75; transition: opacity 0.15s ease; }
  .keyword-chip-action:hover { opacity: 1; text-decoration: underline; }
  .keyword-chip-action:disabled { opacity: 0.4; cursor: wait; }
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

    function showBanner(msg, kind) {
      banner.textContent = msg;
      banner.className = 'status-banner show ' + kind;
      banner.style.cursor = 'pointer';
      banner.title = 'Click to dismiss';
      banner.onclick = () => banner.classList.remove('show');
      // Success/info auto-hide after 8s. Errors stay until clicked or 60s,
      // since they may contain long diagnostic info that takes time to read.
      const hideAfter = kind === 'error' ? 60000 : 8000;
      setTimeout(() => banner.classList.remove('show'), hideAfter);
    }

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

    // PM-271: Account panel sits above the per-site cards. Today it carries
    // the plan badge + the BYOK Ahrefs key input; future account-wide settings
    // belong here too.
    function renderAccountPanel(customer) {
      const plan = (customer && customer.plan) || 'starter';
      const planLabels = { trial: 'Trial', starter: 'Starter', pro: 'Pro' };
      const planLabel = planLabels[plan] || plan;
      const planBadge = plan === 'pro' ? 'publish' : plan === 'starter' ? 'ready' : 'draft';
      const hasAhrefsKey = Boolean(customer && customer.hasAhrefsKey);
      const canUseSystem = Boolean(customer && customer.canUseSystemAhrefs);
      const ahrefsLine = canUseSystem
        ? 'Ahrefs is included with your Pro plan — Phoenix Method covers the bill. Paste a personal key below only if you want your own Ahrefs account credited.'
        : hasAhrefsKey
          ? 'Your Ahrefs key is on file — Ahrefs is unlocked as a keyword source for any of your sites.'
          : 'Paste an Ahrefs API key to unlock the Ahrefs keyword source on any site, on any plan. Or upgrade to Pro and we cover it.';
      return '<details class="panel" style="margin-bottom:24px;">' +
        '<summary style="cursor:pointer;font-family:Cinzel,serif;font-size:1.05rem;letter-spacing:0.02em;display:flex;align-items:center;gap:10px;">' +
          'Account · <span class="badge ' + planBadge + '" style="font-size:0.7rem;">' + escapeHTML(planLabel) + ' plan</span>' +
        '</summary>' +
        '<form data-account-form="1" style="display:grid;gap:14px;margin-top:14px;max-width:640px;">' +
          '<div>' +
            '<label>Ahrefs API key</label>' +
            '<input type="password" name="ahrefsApiKey" placeholder="' + (hasAhrefsKey ? '••• key already on file — paste to replace, leave blank to keep' : 'Paste your Ahrefs API key (optional)') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);">' +
            '<p class="help" style="margin-top:6px;">' + ahrefsLine + '</p>' +
            (hasAhrefsKey ? '<button type="button" class="link-like" data-action="clear-ahrefs-key" style="margin-top:6px;color:var(--danger);">Remove key</button>' : '') +
          '</div>' +
          '<div><button type="submit" class="btn btn-primary">Save account settings</button></div>' +
        '</form>' +
      '</details>';
    }

    function renderSite(site, keywords, articles, customer) {
      // PM-271: Ahrefs is gated. BYOK customers can use it on any plan; system
      // key is included on Pro. The radio disables when neither path applies,
      // with help copy explaining how to unlock.
      const canUseAhrefs = Boolean(customer && customer.canUseAhrefs);
      const ahrefsViaSystem = Boolean(customer && customer.canUseSystemAhrefs);
      const ahrefsViaBYOK = Boolean(customer && customer.hasAhrefsKey);
      const articleRows = articles.length ? articles.map(a => {
        const link = a.publicUrl ? a.publicUrl : (a.wpEditUrl || '');
        const wasPublished = a.status === 'publish' || a.publishedAt;
        const canPublish = a.status === 'draft' || a.status === 'failed';
        const cmsAttr = escapeHTML(site.cms || '');
        const titleAttr = escapeHTML(a.title || a.slug || 'this article');
        const actionParts = [];
        actionParts.push('<button class="link-like" data-action="view-article" data-site="' + site.id + '" data-article="' + a.id + '">View / copy</button>');
        if (link) actionParts.push('<a href="' + link + '" target="_blank" rel="noopener">Open ↗</a>');
        if (canPublish) actionParts.push('<button class="link-like" data-action="publish-article" data-site="' + site.id + '" data-article="' + a.id + '" data-cms="' + cmsAttr + '" data-title="' + titleAttr + '" style="color:var(--fire);font-weight:600;">Publish</button>');
        actionParts.push('<button class="link-like" data-action="delete-article" data-site="' + site.id + '" data-article="' + a.id + '" data-published="' + (wasPublished ? '1' : '0') + '" data-cms="' + cmsAttr + '" data-title="' + titleAttr + '" style="color:var(--deep);">Delete</button>');
        const actionsHtml = actionParts.join('<span class="action-sep">·</span>');
        const badgeClass = a.status === 'publish' ? 'publish' : a.status === 'failed' ? 'failed' : a.status === 'ready' ? 'ready' : 'draft';
        const indexWarning = a.indexWarning ? '<div style="margin-top:6px;padding:8px 10px;background:rgba(255,170,0,0.08);border-left:3px solid #FF8C00;border-radius:4px;font-size:0.82rem;color:#FFB800;line-height:1.5;">⚠ ' + escapeHTML(a.indexWarning) + '</div>' : '';
        return '<tr>' +
          '<td>' + escapeHTML(a.title || '—') + '<div style="color:var(--deep);font-size:0.82rem;margin-top:2px;">' + escapeHTML(a.keyword || '') + '</div>' + indexWarning + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + escapeHTML(a.status || 'draft') + '</span></td>' +
          '<td>' + escapeHTML(formatDate(a.generatedAt)) + '</td>' +
          '<td class="actions-cell"><div class="actions">' + actionsHtml + '</div></td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="4" style="color:var(--deep);text-align:center;padding:24px;">No articles yet. Click <em>Generate Article Now</em> above to create your first.</td></tr>';

      const keywordChips = keywords.length ? keywords.slice(0, 20).map(k => {
        const cls = 'keyword-chip' + (k.picked ? ' picked' : '') + (k.rejected ? ' rejected' : '');
        const textStyle = k.rejected ? ' style="text-decoration:line-through;opacity:0.55;"' : '';
        const tooltip = k.rejected
          ? 'Rejected: ' + (k.rejectionReason || 'off-niche')
          : 'vol ' + k.volume + ' / KD ' + k.kd + ' / ' + (k.intent || '');
        // PM-264: Write button on non-rejected chips fires gen on this exact keyword.
        const writeBtn = k.rejected
          ? ''
          : '<button type="button" class="keyword-chip-action" data-action="generate-keyword" data-site="' + site.id + '" data-keyword="' + escapeHTML(k.keyword) + '" title="Generate an article on this keyword">Write</button>';
        return '<span class="' + cls + '" title="' + escapeHTML(tooltip) + '">' +
          '<span class="keyword-chip-text"' + textStyle + '>' + escapeHTML(k.keyword) + '</span>' +
          writeBtn +
          '<button type="button" class="keyword-chip-remove" data-action="remove-keyword" data-site="' + site.id + '" data-keyword="' + escapeHTML(k.keyword) + '" title="Remove and block from future research" aria-label="Remove keyword">×</button>' +
        '</span>';
      }
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
            '<button class="btn btn-primary" data-action="generate" data-site="' + site.id + '" data-cms="' + escapeHTML(site.cms || '') + '" data-autopublish="' + (site.autoPublish ? '1' : '0') + '">Generate Article</button>' +
            '<button class="btn btn-ghost" data-action="research" data-site="' + site.id + '">Refresh keywords</button>' +
            (gscConnected
              ? '<button class="btn btn-ghost" data-action="gsc-disconnect" data-site="' + site.id + '">Disconnect GSC</button>'
              : '<button class="btn btn-ghost" data-action="gsc-connect" data-site="' + site.id + '">Connect GSC</button>') +
            '<button class="btn btn-danger" data-action="disconnect" data-site="' + site.id + '" style="margin-left:auto;">Disconnect site</button>' +
          '</div>' +
        '</div>' +
        keywordSourceBanner +
        '<details style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">' +
          '<summary style="cursor:pointer;color:var(--muted);font-family:\\'Rajdhani\\',sans-serif;font-size:0.82rem;letter-spacing:0.1em;text-transform:uppercase;">Settings</summary>' +
          '<form data-settings-site="' + site.id + '" style="display:grid;gap:14px;margin-top:14px;max-width:640px;">' +
            '<div>' +
              '<label>Brand name</label>' +
              '<input type="text" name="brandName" value="' + escapeHTML(site.brandName || '') + '" placeholder="' + escapeHTML(siteBrandName(site)) + '" maxlength="80" style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;">' +
              '<p class="help" style="margin-top:6px;">Used in &lt;title&gt; suffix, OpenGraph site_name, and Article schema author/publisher. Leave empty to auto-derive from the URL (placeholder shows the fallback).</p>' +
            '</div>' +
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
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:' + (canUseAhrefs ? 'pointer' : 'not-allowed') + ';text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);' + (canUseAhrefs ? '' : 'opacity:0.6;') + '">' +
                  '<input type="radio" name="keywordSource" value="ahrefs"' + (keywordSource === 'ahrefs' ? ' checked' : '') + (canUseAhrefs ? '' : ' disabled') + ' style="margin-top:4px;">' +
                  '<span><strong>Ahrefs</strong>' +
                    (ahrefsViaSystem ? ' <span class="badge publish" style="font-size:0.62rem;">Included with Pro</span>' : ahrefsViaBYOK ? ' <span class="badge ready" style="font-size:0.62rem;">Your key</span>' : ' <span class="badge draft" style="font-size:0.62rem;">Locked</span>') +
                    '<br><span style="color:var(--muted);font-size:0.85rem;">Discovers brand-new keywords for sites with no traffic yet. ' +
                      (ahrefsViaSystem
                        ? 'Phoenix Method covers the Ahrefs bill on your Pro plan.'
                        : ahrefsViaBYOK
                          ? 'Using your Ahrefs API key from Account settings.'
                          : 'Requires the Pro plan, or paste your own Ahrefs API key in the Account section above.') +
                    '</span></span>' +
                '</label>' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="keywordSource" value="serpbear"' + (keywordSource === 'serpbear' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>SerpBear</strong> <span class="badge ready" style="font-size:0.62rem;">Self-hosted</span><br><span style="color:var(--muted);font-size:0.85rem;">Pulls keywords from your own SerpBear instance. Free + open-source; no Ahrefs / Semrush bill.</span></span>' +
                '</label>' +
                '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.92rem;color:var(--text);">' +
                  '<input type="radio" name="keywordSource" value="manual"' + (keywordSource === 'manual' ? ' checked' : '') + ' style="margin-top:4px;">' +
                  '<span><strong>Manual only</strong><br><span style="color:var(--muted);font-size:0.85rem;">No upstream source — only use your manual list below. Best for brand-new sites with no GSC data yet. (Manual keywords are also additive for the three sources above — you don\\'t have to pick this just to use your list.)</span></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<label>Manual keywords (always included)</label>' +
              '<textarea name="manualKeywords" rows="6" placeholder="one keyword per line: best dental clinic seattle, teeth whitening cost, pediatric dentist near me" style="width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;resize:vertical;">' + escapeHTML((site.manualKeywords || []).map(k => typeof k === 'string' ? k : k.keyword).join('\\n')) + '</textarea>' +
              '<p class="help" style="margin-top:6px;">Optional. One per line, up to 50. These get merged on top of your primary source (deduped) and are exempt from the LLM off-niche filter — anything you paste here is trusted and sorted to the top of the chip list.</p>' +
            '</div>' +
            '<div data-keyword-source-fields="serpbear" style="display:' + (keywordSource === 'serpbear' ? 'block' : 'none') + ';">' +
              '<label>SerpBear connection</label>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">' +
                '<div><label style="font-size:0.7rem;">Base URL</label><input type="url" name="serpBearUrl" value="' + escapeHTML(site.serpBearUrl || '') + '" placeholder="https://serpbear.yourdomain.com" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
                '<div><label style="font-size:0.7rem;">Tracked domain</label><input type="text" name="serpBearDomain" value="' + escapeHTML(site.serpBearDomain || '') + '" placeholder="yourdomain.com (defaults to site host)" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>' +
              '</div>' +
              '<label style="font-size:0.7rem;margin-top:10px;">API key</label>' +
              '<input type="password" name="serpBearApiKey" placeholder="' + (site.hasSerpBearKey ? '••• key already set — paste to replace, leave blank to keep' : 'paste your SerpBear API key') + '" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);">' +
              '<p class="help" style="margin-top:6px;">Generate at <em>SerpBear Settings → API key</em>. Stored AES-encrypted; only used to GET keyword lists for this site.</p>' +
            '</div>' +
            '<div>' +
              '<label>Keyword relevance filter</label>' +
              '<div style="display:grid;gap:6px;margin-top:6px;">' +
                '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--text);"><input type="radio" name="keywordFilter" value="auto"' + ((site.keywordFilter || "auto") === "auto" ? ' checked' : '') + '> Auto-filter — Llama 3.3 70B rejects off-niche keywords (e.g. brand-name geo noise) before they reach the article generator. Rejected terms stay visible in the queue with reasons.</label>' +
                '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--text);"><input type="radio" name="keywordFilter" value="off"' + (site.keywordFilter === "off" ? ' checked' : '') + '> Off — every keyword from your source goes straight into the queue, no filtering.</label>' +
              '</div>' +
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
                '<label style="font-size:0.7rem;margin-top:14px;">Static site generator</label>' +
                '<select name="ssgOverride" style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'Outfit\\',sans-serif;font-size:0.95rem;margin-top:6px;">' +
                  (function() {
                    var current = site.ssgOverride || 'auto';
                    var opts = [
                      ['auto', 'Auto-detect (Jekyll / Hugo / 11ty / Astro on every publish)'],
                      ['jekyll', 'Force Jekyll'],
                      ['hugo', 'Force Hugo'],
                      ['eleventy', 'Force 11ty (Eleventy)'],
                      ['astro', 'Force Astro'],
                      ['none', 'Force standalone HTML (no SSG)'],
                    ];
                    return opts.map(function (o) {
                      return '<option value="' + o[0] + '"' + (current === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
                    }).join('');
                  })() +
                '</select>' +
                '<p class="help" style="margin-top:6px;">Override what Phoenix AI commits to your repo. <strong>Auto</strong> probes the repo on every publish; the other options skip detection. Use <strong>none</strong> if auto-detection is guessing wrong and committing the wrong file format.</p>' +
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

        const sitesHtml = details.map(d => renderSite(d.site, d.keywords, d.articles, me.customer)).join('');
        // Paywall: each customer's plan includes a fixed number of sites
        // (default 1). When they're at the cap, hide the connect form and
        // show a contact-to-upgrade card instead. Backend enforces the same
        // limit so curling the API can't bypass it.
        const limit = me.customer.siteLimit || 1;
        const atLimit = me.sites.length >= limit;
        const connectPanel = atLimit
          ? '<div class="panel" style="background:linear-gradient(135deg,rgba(255,77,0,0.06),rgba(255,184,0,0.03));border-color:rgba(255,140,0,0.25);">' +
              '<h3 style="margin-top:0;">Want articles for another site?</h3>' +
              '<p style="margin:0 0 14px;color:var(--muted);">Your plan includes <strong>' + limit + ' site' + (limit === 1 ? '' : 's') + '</strong>. Each additional site is billed separately so we can keep generating articles, doing keyword research, and committing to your repo daily without burning your budget on sites you\\'re not actively working on.</p>' +
              '<a href="mailto:hello@phoenixmethodseo.com?subject=Add%20another%20site%20to%20Phoenix%20AI&body=I%27d%20like%20to%20add%20another%20site%20to%20my%20Phoenix%20AI%20account.%20My%20current%20site%20is%3A%20" class="btn btn-primary">Email to add a site</a>' +
            '</div>'
          : '<div class="panel"><h3 style="margin-top:0;">Connect Another Site</h3><div id="connectFormSlot"></div></div>';
        root.innerHTML = '<h1>Your Sites</h1><p class="lede">Manage your connected sites, refresh keyword research, and ship articles.</p>' +
          renderAccountPanel(me.customer) +
          sitesHtml +
          connectPanel;

        if (!atLimit) {
          const form = document.getElementById('connectFormTemplate').content.cloneNode(true);
          document.getElementById('connectFormSlot').appendChild(form);
          attachConnectForm(document.getElementById('connectForm'));
        }

        root.addEventListener('click', onAction, { once: false });
        root.querySelectorAll('form[data-settings-site]').forEach(attachSettingsForm);
        // PM-271: Account panel form (BYOK Ahrefs key) lives above the sites.
        const acctForm = root.querySelector('form[data-account-form]');
        if (acctForm) attachAccountForm(acctForm);
      } catch (err) {
        root.innerHTML = '<div class="panel"><h2>Couldn\\'t load your dashboard</h2><p class="lede">' + escapeHTML(err.message) + '</p><a class="btn btn-primary" href="/">Reload</a></div>';
      }
    }

    // PM-271: Account form (BYOK Ahrefs key). Empty submission keeps the
    // existing key; pasting a new one replaces; the "Remove key" link clears.
    function attachAccountForm(form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        const keyInput = form.querySelector('input[name=ahrefsApiKey]');
        const keyValue = keyInput ? keyInput.value.trim() : '';
        btn.disabled = true; btn.innerHTML = '<span class="loader"></span>Saving…';
        try {
          // Only send the field when the customer typed something — empty
          // string means "keep what's stored" (matches the Anthropic key
          // pattern in per-site Settings).
          const patch = {};
          if (keyValue) patch.ahrefsApiKey = keyValue;
          if (!Object.keys(patch).length) {
            showBanner('Nothing to save — paste a new Ahrefs key, or use Remove key to clear it.', 'info');
            btn.disabled = false; btn.textContent = 'Save account settings';
            return;
          }
          await api('PATCH', '/api/me', patch);
          showBanner('Account settings saved.', 'success');
          await load();
        } catch (err) {
          showBanner('Save failed: ' + err.message, 'error');
          btn.disabled = false; btn.textContent = 'Save account settings';
        }
      });
    }

    function attachSettingsForm(form) {
      // Show/hide source-specific conditional fields as the radio toggles.
      // PM-267: 'manual' is no longer source-conditional — the manual list is
      // always visible and additive. Only SerpBear has source-only fields now.
      form.querySelectorAll('input[name=keywordSource]').forEach((r) => {
        r.addEventListener('change', () => {
          if (!r.checked) return;
          ['serpbear'].forEach((kind) => {
            const block = form.querySelector('[data-keyword-source-fields=' + kind + ']');
            if (block) block.style.display = r.value === kind ? 'block' : 'none';
          });
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
          const brandNameField = form.querySelector('input[name=brandName]');
          const patch = {
            brandName: brandNameField ? brandNameField.value : '',
            brandVoiceOverride: form.querySelector('textarea[name=brandVoiceOverride]').value,
            requireApproval: form.querySelector('input[name=requireApproval]').checked,
            autoPublish: form.querySelector('input[name=autoPublish]').checked,
            keywordSource: sourceRadio ? sourceRadio.value : undefined,
            keywordFilter: (form.querySelector('input[name=keywordFilter]:checked') || {}).value,
            llmProvider: providerRadio ? providerRadio.value : undefined,
            manualKeywords,
          };
          if (keyValue) patch.anthropicApiKey = keyValue;
          // SerpBear fields appear when keywordSource is serpbear.
          const sbUrlEl = form.querySelector('input[name=serpBearUrl]');
          if (sbUrlEl) {
            patch.serpBearUrl = sbUrlEl.value.trim();
            patch.serpBearDomain = form.querySelector('input[name=serpBearDomain]').value.trim();
            const sbKey = form.querySelector('input[name=serpBearApiKey]').value.trim();
            if (sbKey) patch.serpBearApiKey = sbKey;
          }
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
            const ssgSel = form.querySelector('select[name=ssgOverride]');
            if (ssgSel) patch.ssgOverride = ssgSel.value;
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
      if (action === 'publish-article') {
        const articleId = btn.dataset.article;
        const cms = btn.dataset.cms;
        const title = btn.dataset.title;
        const cmsLabel = cms === 'wordpress' ? 'WordPress site' : cms === 'github-pages' ? 'GitHub repo' : 'destination';
        const msg = cms === 'manual'
          ? 'Mark "' + title + '" as ready for copy/paste? (Manual sites have no automated publish step — this just flips the status.)'
          : 'Publish "' + title + '" to your ' + cmsLabel + '? This goes live immediately.';
        if (!window.confirm(msg)) return;
        btn.disabled = true; btn.textContent = 'Publishing…';
        try {
          const res = await api('POST', '/api/sites/' + siteId + '/articles/' + articleId + '/publish');
          if (res.alreadyPublished) {
            showBanner('"' + title + '" was already published.', 'info');
          } else {
            const extra = res.article && res.article.indexWarning ? ' (heads up — your hand-curated blog index was preserved; see the article row for marker setup.)' : '';
            // GitHub Pages rebuilds the site after each commit — typically
            // 30-90 seconds. If the customer clicks Open ↗ during that
            // window they'll see a 404 and think we're broken. Call it out.
            const buildLag = cms === 'github-pages' ? ' Your live URL works in 1-2 minutes (GitHub Pages rebuild).' : '';
            showBanner('Published "' + title + '" to your ' + cmsLabel + '.' + buildLag + extra, 'success');
          }
          await load();
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Publish';
          showBanner('Publish failed: ' + err.message, 'error');
        }
        return;
      }
      if (action === 'delete-article') {
        const articleId = btn.dataset.article;
        const wasPublished = btn.dataset.published === '1';
        const cms = btn.dataset.cms;
        const title = btn.dataset.title;
        // Confirm-dialog copy is CMS-specific so the customer knows exactly
        // what will happen on the destination side before they click OK.
        let confirmMsg;
        if (!wasPublished) {
          confirmMsg = 'Delete "' + title + '"?\\n\\nThis is a draft — nothing was published anywhere. Removes from Phoenix AI only.';
        } else if (cms === 'github-pages') {
          confirmMsg = 'Delete "' + title + '"?\\n\\nThis will:\\n  • Remove the article from Phoenix AI\\n  • Commit 3 deletions to your GitHub repo (post HTML, hero image, blog index entry)\\n  • Your live site will reflect this in ~1 minute (GitHub Pages rebuild)\\n\\nCannot be undone.';
        } else if (cms === 'wordpress') {
          confirmMsg = 'Delete "' + title + '"?\\n\\nThis will:\\n  • Remove the article from Phoenix AI\\n  • Permanently delete the post from your WordPress site (skips trash — gone for good)\\n  • Visitors will get a 404 immediately\\n\\nCannot be undone.';
        } else {
          confirmMsg = 'Delete "' + title + '"?\\n\\nRemoves from Phoenix AI only. If you copied this article into your CMS (Squarespace / Wix / etc.) you\\'ll need to remove it there yourself.';
        }
        if (!window.confirm(confirmMsg)) return;
        btn.disabled = true; btn.textContent = 'Deleting…';
        try {
          const res = await api('DELETE', '/api/sites/' + siteId + '/articles/' + articleId);
          const cmsResult = res.cmsDelete || {};
          // Success-banner copy is also CMS-specific. Tells the customer
          // exactly what got cleaned up, where to look to verify, and how
          // long until they'll see the change on their live site.
          let banner, kind = 'success';
          if (cmsResult.skipped) {
            banner = 'Deleted "' + title + '" from Phoenix AI. It was a draft — nothing was ever published.';
          } else if (cmsResult.ok) {
            if (cms === 'github-pages') {
              banner = 'Deleted "' + title + '". Removed from Phoenix AI + 3 commits to your GitHub repo (post, image, index entry). Live site updates in ~1 minute.';
            } else if (cms === 'wordpress') {
              banner = 'Deleted "' + title + '". Removed from Phoenix AI + permanently deleted from your WordPress site. Visitors will see a 404 now.';
            } else {
              banner = 'Deleted "' + title + '" from Phoenix AI.' + (wasPublished ? ' If you previously copied this article into another CMS, remove it there yourself.' : '');
            }
          } else {
            kind = 'error';
            if (cms === 'github-pages') {
              banner = 'Removed "' + title + '" from Phoenix AI, but at least one GitHub commit failed: ' + (cmsResult.error || 'unknown error') + '. Open your repo, delete the post HTML + image in /blog/, and remove the entry from blog/index.html.';
            } else if (cms === 'wordpress') {
              banner = 'Removed "' + title + '" from Phoenix AI, but the WordPress delete failed: ' + (cmsResult.error || 'unknown error') + '. Log in to /wp-admin/, find the post, click Delete Permanently.';
            } else {
              banner = 'Removed "' + title + '" from Phoenix AI, but the destination cleanup failed: ' + (cmsResult.error || 'unknown error') + '.';
            }
          }
          showBanner(banner, kind);
          await load();
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Delete';
          showBanner('Delete failed: ' + err.message, 'error');
        }
        return;
      }
      if (action === 'gsc-connect') {
        // Full-page redirect to start the OAuth flow on the worker.
        window.location.href = '/auth/google/start?siteId=' + encodeURIComponent(siteId);
        return;
      }
      if (action === 'gsc-pick') {
        return pickGscProperty(siteId);
      }
      if (action === 'clear-ahrefs-key') {
        // PM-271: clear the BYOK Ahrefs key. PATCH /api/me with empty string.
        if (!window.confirm('Remove your Ahrefs API key?\\n\\nIf you\\'re on Pro your sites keep using Ahrefs (system key). If you\\'re not on Pro the Ahrefs source will lock.')) return;
        btn.disabled = true;
        try {
          await api('PATCH', '/api/me', { ahrefsApiKey: '' });
          showBanner('Ahrefs key removed.', 'info');
          await load();
        } catch (err) {
          btn.disabled = false;
          showBanner('Couldn\\'t remove key: ' + err.message, 'error');
        }
        return;
      }
      if (action === 'remove-keyword') {
        const keyword = btn.dataset.keyword;
        if (!keyword) return;
        if (!window.confirm('Remove "' + keyword + '"?\\n\\nIt will be excluded from future keyword research for this site. Contact support to restore it later.')) return;
        btn.disabled = true;
        try {
          await api('POST', '/api/sites/' + siteId + '/keywords/remove', { keyword });
          showBanner('Removed "' + keyword + '" and blocked from future research.', 'info');
          await load();
        } catch (err) {
          btn.disabled = false;
          showBanner('Remove failed: ' + err.message, 'error');
        }
        return;
      }
      if (action === 'generate-keyword') {
        // PM-264: explicit per-keyword article gen. Same job + polling flow
        // as the site-level Generate button, but with the chosen keyword
        // sent in the body so the backend skips pickNextKeyword.
        const keyword = btn.dataset.keyword;
        if (!keyword) return;
        if (!window.confirm('Generate an article on "' + keyword + '"?\\n\\nPhoenix AI will use your site\\'s default length, tone, and image settings. Takes 30-60s.')) return;
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const out = await api('POST', '/api/sites/' + siteId + '/generate', { keyword });
          showBanner('Generating "' + keyword + '" with Llama 3.3 70B + FLUX hero image — 30-60s. The dashboard updates automatically.', 'info');
          const jobId = out.jobId;
          const startedPolling = Date.now();
          const POLL_MS = 2000;
          const TIMEOUT_MS = 5 * 60 * 1000;
          let final = null, timedOut = false, lostTrack = false;
          while (true) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            let j;
            try { j = await api('GET', '/api/jobs/' + jobId); }
            catch (err) { lostTrack = err.message; break; }
            const s = j.job && j.job.status;
            if (s === 'done' || s === 'failed') { final = j.job; break; }
            if (Date.now() - startedPolling > TIMEOUT_MS) { timedOut = true; break; }
          }
          if (lostTrack) {
            showBanner('Lost track of the generation job: ' + lostTrack + '. Refresh in a minute to see if it landed.', 'error');
          } else if (timedOut) {
            showBanner('Generation is taking longer than 5 minutes — it may still complete in the background. Refresh the dashboard in a minute.', 'info');
          } else if (final.status === 'failed') {
            showBanner('Generation failed: ' + (final.error || 'unknown error'), 'error');
          } else {
            showBanner('Article on "' + keyword + '" generated — see the table below.', 'success');
          }
          await load();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = originalLabel;
          showBanner('Generate failed: ' + err.message, 'error');
        }
        return;
      }
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.innerHTML = '<span class="loader"></span>' + originalText;
      try {
        if (action === 'generate') {
          // The POST now runs the pipeline synchronously and returns when
          // the job is done or failed (ctx.waitUntil was getting cancelled
          // on Workers Free). We still poll /api/jobs/:id afterwards so the
          // existing UX (loader → success/failure banner) doesn't change —
          // the first poll just sees the final status straight away.
          const out = await api('POST', '/api/sites/' + siteId + '/generate');
          showBanner('Generating with Llama 3.3 70B + FLUX hero image — this takes 30-60s. The dashboard will update automatically.', 'info');
          btn.innerHTML = '<span class="loader"></span>Generating…';
          const jobId = out.jobId;
          const startedPolling = Date.now();
          const POLL_MS = 2000;
          const TIMEOUT_MS = 5 * 60 * 1000;
          let final = null, timedOut = false, lostTrack = false;
          while (true) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            let j;
            try { j = await api('GET', '/api/jobs/' + jobId); }
            catch (err) { lostTrack = err.message; break; }
            const s = j.job && j.job.status;
            if (s === 'done' || s === 'failed') { final = j.job; break; }
            if (Date.now() - startedPolling > TIMEOUT_MS) { timedOut = true; break; }
          }
          if (lostTrack) {
            showBanner('Lost track of the generation job: ' + lostTrack + '. Refresh in a minute to see if it landed.', 'error');
          } else if (timedOut) {
            showBanner('Generation is taking longer than 5 minutes — it may still complete in the background. Refresh the dashboard in a minute.', 'info');
          } else if (final.status === 'failed') {
            showBanner('Generation failed: ' + (final.error || 'unknown error'), 'error');
          } else {
            const extra = final.indexWarning ? ' (heads up — your hand-curated blog index was preserved; the article row has details on adding markers.)' : '';
            // If this site auto-publishes to github-pages, the customer will
            // try to click Open ↗ immediately and hit a 404 during the
            // GitHub Pages rebuild window. Forewarn.
            const willAutoPublish = btn.dataset.cms === 'github-pages' && btn.dataset.autopublish === '1';
            const buildLag = willAutoPublish ? ' Your live URL works in 1-2 minutes (GitHub Pages rebuild).' : '';
            showBanner('Article generated — see the table below.' + buildLag + extra, 'success');
          }
        } else if (action === 'research') {
          // Research now runs an LLM relevance judge (PM-253) which adds
          // 10-15s. Show an immediate in-progress banner so the customer
          // can see the request fired and isn't confused by the wait.
          showBanner('Researching keywords + LLM relevance filtering — this takes 15-30s. The chip list above will refresh when done.', 'info');
          const out = await api('POST', '/api/sites/' + siteId + '/research');
          const isFallback = (out.source || '').includes('seed');
          const rejectedCount = (out.keywords || []).filter((k) => k.rejected).length;
          const availableCount = (out.keywords || []).filter((k) => !k.rejected).length;
          if (isFallback && out.seedKind === 'llm') {
            // PM-269: LLM-generated seeds — varied, fresh candidates.
            showBanner('Refreshed — your primary source had no data, so we asked the AI for ' + out.count + ' fresh keyword candidates tailored to your site. Connect GSC or paste a manual list in Settings for the most targeted results.', 'info');
          } else if (isFallback) {
            showBanner('Refreshed — your primary source returned nothing, so we seeded ' + out.count + ' niche-derived starters. Add a few manual keywords in Settings for better results.', 'info');
          } else {
            let detail = 'Refreshed — ' + out.count + ' keywords from ' + (out.source || 'gsc') + '.';
            if (rejectedCount) detail += ' ' + rejectedCount + ' rejected as off-niche (struck through in the chip list), ' + availableCount + ' available for article gen.';
            else detail += ' All on-niche, ready for article gen.';
            showBanner(detail, 'success');
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
