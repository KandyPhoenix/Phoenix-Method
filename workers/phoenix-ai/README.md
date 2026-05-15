# Phoenix AI — SEO Content Autopilot

A self-serve SaaS that researches keywords, writes SEO articles, and publishes them to a customer's WordPress site.

The marketing page is at `phoenixmethod.com/phoenix-ai/` (in this repo at `/phoenix-ai/index.html`). The product runs as a single Cloudflare Worker in this directory.

---

## How the pipeline works

```
customer signs up (magic link)
        │
        ▼
connects WordPress site (URL + app password)
        │                                ┌─ stored AES-encrypted in KV
        ▼                                │
worker fetches homepage HTML ────────────┘
        │  derives niche + brand-voice sample
        ▼
keyword research — default GSC (free), optional Ahrefs, or manual paste
        │  GSC: position 5–20 queries scored by impressions × (1 − CTR)
        ▼
KV: kws:<siteId>  ←  a queue of 25 unpicked keywords
        │
        ▼  manual "Generate Now" or daily cron
pick next unpicked keyword
        │
        ▼
LLM (JSON-mode prompt) → {title, slug, meta, html, faqs, tags}
        │
        ▼
WordPress REST: POST /wp-json/wp/v2/posts (Basic auth = appUser:appPassword)
        │
        ▼
KV: art:<siteId>:<articleId>  ←  full record (html, status, wpEditUrl)
        │
        ▼
dashboard lists it, customer reviews / publishes
```

---

## Routes

### Public
- `POST /auth/request` — `{ email }` → emails a magic link. Always returns 200.
- `GET  /auth/verify?t=` — validates magic token, sets a 30-day session cookie, redirects to `/app/`.
- `GET  /auth/logout` — clears the cookie.
- `GET  /auth/google/start?siteId=` — starts Google OAuth for GSC keyword research.
- `GET  /auth/google/callback?code=&state=` — finishes Google OAuth, stores tokens, returns to `/app/`.
- `GET  /` — redirects authed users to `/app/`, anonymous to the marketing page.

### Dashboard (HTML)
- `GET /app/` — single-page SPA shell. Renders client-side from `/api/me`.

### API (session-gated, JSON)
- `GET    /api/me` — `{ customer, sites }`
- `POST   /api/sites` — `{ url, cms, appUsername?, appPassword?, brandVoiceOverride?, requireApproval?, keywordSource?, manualKeywords? }`
- `PATCH  /api/sites/:siteId` — edit `brandVoiceOverride`, `requireApproval`, `autoPublish`, `keywordSource`, `manualKeywords`
- `DELETE /api/sites/:siteId`
- `POST   /api/sites/:siteId/research` — refreshes keyword research now
- `GET    /api/sites/:siteId/keywords` — `{ keywords: [...] }`
- `GET    /api/sites/:siteId/gsc/properties` — list GSC properties on the connected Google account
- `PATCH  /api/sites/:siteId/gsc/property` — `{ property }` → set the active GSC property for this site
- `DELETE /api/sites/:siteId/gsc` — disconnect GSC (clears stored OAuth tokens)
- `POST   /api/sites/:siteId/generate` — runs the pipeline once (LLM + WP publish)
- `GET    /api/sites/:siteId/articles` — newest-first summaries
- `GET    /api/sites/:siteId/articles/:articleId` — full article record (incl. html)

### Scheduled
- Cron `0 13 * * *` — Phase 2. Only fires if `CRON_ENABLED=true` (var). Walks every active site and runs the pipeline once.

---

## KV layout

| Binding     | Key                              | Value                                                                                     |
|-------------|----------------------------------|-------------------------------------------------------------------------------------------|
| `CUSTOMERS` | `<email>`                        | `{ email, plan, trialEnds, createdAt }`                                                   |
| `SITES`     | `site:<siteId>`                  | `{ id, ownerEmail, url, cms, appUsername, appPassword(enc), niche, brandVoice, brandVoiceOverride, autoPublish, requireApproval, keywordSource, gsc:{accessToken(enc),refreshToken(enc),expiresAt,property,connectedAt}, manualKeywords, status, createdAt }` |
| `SITES`     | `owner:<email>`                  | `[siteId, ...]` (an index of which sites a customer owns)                                 |
| `KEYWORDS`  | `kws:<siteId>`                   | `[{ keyword, volume, kd, intent, opportunity, score, picked, pickedAt }, ...]` (GSC source: `volume`=impressions, `kd`=position) |
| `ARTICLES`  | `art:<siteId>:<articleId>`       | full record (incl. `html`)                                                                |
| `ARTICLES`  | `list:<siteId>`                  | `[articleId, ...]` newest-first index                                                     |
| `RATE_LIMIT`| `rl:<ip>`                        | counter, 10-minute TTL                                                                    |
| `AUDIT_LOG` | `log:<siteId>:<ts>`              | `{ event, detail, at }` 30-day TTL                                                        |

WordPress application passwords AND Google OAuth refresh/access tokens are all stored AES-GCM encrypted with a key derived from `SESSION_SECRET`. Never in plaintext.

---

## Keyword sources

Phoenix AI defaults to **Google Search Console** as the keyword source — free for any verified site owner. Three sources are supported per-site:

| Source | What it does | Cost | Best for |
|---|---|---|---|
| **`gsc`** (default) | OAuth into the customer's GSC, pull last 90 days of queries where they rank position 5–20, sort by missed-clicks (`impressions × (1 − CTR)`) | Free | Any site with existing GSC data |
| **`ahrefs`** | Calls Ahrefs Keywords Explorer API; falls back to seeded keywords if no key | Requires `AHREFS_API_KEY` worker secret | Brand-new sites with no traffic; competitor-gap discovery |
| **`manual`** | Customer pastes 10–30 starter keywords; pipeline picks from those | Free | Brand-new sites where the customer already has a keyword list |

Set per-site from the dashboard Settings panel.

### GSC OAuth setup (one-time, per worker)

1. https://console.cloud.google.com → enable **Search Console API**
2. OAuth consent screen → External, add scope `https://www.googleapis.com/auth/webmasters.readonly`
3. Credentials → OAuth Client ID → Web application
   - Authorized JavaScript origins: `https://phoenix-ai.phoenixmethod.workers.dev`
   - Authorized redirect URIs: `https://phoenix-ai.phoenixmethod.workers.dev/auth/google/callback`
4. `wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

---

## First-time setup (post-merge)

```sh
cd workers/phoenix-ai

# 1) Create KV namespaces and copy the printed IDs into wrangler.toml
wrangler kv:namespace create CUSTOMERS
wrangler kv:namespace create SITES
wrangler kv:namespace create KEYWORDS
wrangler kv:namespace create ARTICLES
wrangler kv:namespace create RATE_LIMIT
wrangler kv:namespace create AUDIT_LOG

# 2) Set secrets
wrangler secret put SESSION_SECRET     # any 32+ random chars
wrangler secret put RESEND_API_KEY     # magic-link email
wrangler secret put AI_API_KEY         # LLM provider API key
wrangler secret put AI_API_URL         # LLM provider endpoint URL
wrangler secret put AI_API_VERSION     # LLM provider version header (optional)
wrangler secret put AI_MODEL_ID        # LLM model identifier
wrangler secret put GOOGLE_CLIENT_ID   # GSC OAuth client ID
wrangler secret put GOOGLE_CLIENT_SECRET  # GSC OAuth client secret
wrangler secret put AHREFS_API_KEY     # optional — only needed for keywordSource=ahrefs

# 3) Deploy
wrangler deploy
```

The worker is reachable at `https://phoenix-ai.phoenixmethod.workers.dev/`. The marketing page on phoenixmethodseo.com posts to its `/auth/request` directly.

---

## Dogfooding on phoenixmethodseo.com (customer #0)

1. Sign up at `phoenixmethodseo.com/phoenix-ai/#signup` with kandyphoenix@hotmail.com (or whichever email you want).
2. Get the magic link, sign in.
3. Click "Connect Site" and enter:
   - URL: `https://phoenixmethodseo.com`
   - Username: your WP username
   - Application password: generated from WP Admin → Users → Profile → Application Passwords
4. Within a few seconds, keyword research populates. Click "Generate Article Now" to ship the first draft to phoenixmethodseo.com's WP.

---

## Phase 2 roadmap

- Flip `CRON_ENABLED=true` and let the daily cron auto-generate
- AI image generation — hero image per article
- Internal linking: crawl the customer's existing posts, pick 2–4 to link from each new article
- Brand-voice tuning: store accepted/rejected drafts, feed into the prompt
- Stripe billing
- Shopify, Webflow, Ghost adapters

---

## Phase 1 limitations

- WordPress only.
- One LLM call per article — Cloudflare's 30s request limit means we can't chain steps in a single request. Internal linking and image generation are deferred for that reason.
- No queueing system; "Generate Now" is synchronous from the dashboard.
- Trial is honor-system. Billing isn't wired up.
- No email notifications on article generation (only the magic-link email).

---

## Operational notes

- Live tail logs: `wrangler tail` from this directory.
- Wipe a customer's data: delete `<email>` from `CUSTOMERS`, then for each id in `SITES:owner:<email>` delete `site:<id>`, `KEYWORDS:kws:<id>`, `ARTICLES:list:<id>` and every `ARTICLES:art:<id>:*`.
- Rotate `SESSION_SECRET` invalidates all sessions AND makes existing AES-encrypted app passwords un-decryptable. Customers will need to re-enter their WP app password.
