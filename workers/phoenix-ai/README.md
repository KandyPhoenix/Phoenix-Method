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
keyword research (Ahrefs v3)
        │  ranked by intent + opportunity
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
- `POST /auth/request` — `{ email }` → emails a magic link (Resend). Always returns 200.
- `GET  /auth/verify?t=` — validates magic token, sets a 30-day session cookie, redirects to `/app/`.
- `GET  /auth/logout` — clears the cookie.
- `GET  /` — redirects authed users to `/app/`, anonymous to the marketing page.

### Dashboard (HTML)
- `GET /app/` — single-page SPA shell. Renders client-side from `/api/me`.

### API (session-gated, JSON)
- `GET    /api/me` — `{ customer, sites }`
- `POST   /api/sites` — `{ url, appUsername, appPassword }` → connects a WP site, learns it, kicks off keyword research
- `DELETE /api/sites/:siteId`
- `POST   /api/sites/:siteId/research` — refreshes keyword research now
- `GET    /api/sites/:siteId/keywords` — `{ keywords: [...] }`
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
| `SITES`     | `site:<siteId>`                  | `{ id, ownerEmail, url, appUsername, appPassword(enc), niche, brandVoice, autoPublish, status, createdAt }` |
| `SITES`     | `owner:<email>`                  | `[siteId, ...]` (an index of which sites a customer owns)                                 |
| `KEYWORDS`  | `kws:<siteId>`                   | `[{ keyword, volume, kd, intent, score, picked, pickedAt }, ...]`                          |
| `ARTICLES`  | `art:<siteId>:<articleId>`       | full record (incl. `html`)                                                                |
| `ARTICLES`  | `list:<siteId>`                  | `[articleId, ...]` newest-first index                                                     |
| `RATE_LIMIT`| `rl:<ip>`                        | counter, 10-minute TTL                                                                    |
| `AUDIT_LOG` | `log:<siteId>:<ts>`              | `{ event, detail, at }` 30-day TTL                                                        |

WordPress application passwords are stored AES-GCM encrypted with a key derived from `SESSION_SECRET`. Never in plaintext.

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
wrangler secret put RESEND_API_KEY     # from resend.com
wrangler secret put AI_API_KEY         # LLM provider API key
wrangler secret put AHREFS_API_KEY     # optional — pipeline falls back to seeded keywords without it

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
