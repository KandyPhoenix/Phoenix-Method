# Onboard a New Client to the Portal

Start-to-finish playbook for setting up a new client's access to `portal.phoenixmethod.workers.dev`.

Estimated time: **10 minutes per client** once you've done it once.

---

## Before you start

You only need three things:
1. The client's **email address** (the one they'll use to sign in)
2. Their **name** (so the sign-in email can say "Hi [Name]")
3. A **slug** for them — a short URL-safe name like `phw`, `lori`, `smith`, `acme`. Lowercase, numbers, and dashes only.

---

## Step 1 — Build their portal content

Every client's portal lives in its own folder under `workers/portal/public/{slug}/`. Start by copying the PHW template and customizing.

```powershell
cd "C:\Users\kandy\PHOENIX METHOD\workers\portal\public"
# Copy PHW as a starting point:
xcopy /E /I phw smith
```

That creates `workers/portal/public/smith/` with the same `index.html`, `data.json`, and PDF/DOCX files.

Now edit `public/smith/data.json` — this is where all the client-facing content lives (rankings, deliverables, reports, etc.). Open it in any text editor, replace PHW-specific values with the new client's info, save.

You can also replace or add PDF/DOCX files in that folder — whatever you want the client to be able to download from inside their portal.

---

## Step 2 — Add the client to the allowlist

Each client is identified by email. The allowlist lives in Cloudflare KV (Workers & Pages → KV → **ALLOWLIST** in the CF dashboard).

1. Go to https://dash.cloudflare.com → **Storage & Databases** → **KV** → click **ALLOWLIST**
2. Click **Add entry**
3. **Key:** the client's email, exactly as they'll type it on the login page (lowercase is safest). Example: `jane@smithco.com`
4. **Value:** a JSON object telling the worker which client folder they can access:
   ```
   {"client":"smith","name":"Jane"}
   ```
   - `client` = the slug you chose (must match the folder name in step 1)
   - `name` = the name shown in the sign-in email greeting
5. Save

If the client has multiple people who should access it (e.g., Jane and her business partner Bob), add separate entries — one per email — both pointing to the same `client` slug.

---

## Step 3 — Deploy the worker

Push the new content up to Cloudflare:

```powershell
cd "C:\Users\kandy\PHOENIX METHOD\workers\portal"
wrangler deploy
```

Takes ~10 seconds. Wrangler will confirm the upload — you should see it mention the new files in `public/{slug}/`.

---

## Step 4 — Test the login flow yourself

Before you email the client:

1. Add yourself to the allowlist as that client temporarily — in the KV dashboard, add an entry with key `kandyphoenix@hotmail.com` (or whichever email you're testing from) and value `{"client":"smith","name":"Kandy (Test)"}`. (Remove this after testing.)
2. Open an **incognito/private browser window**
3. Go to https://portal.phoenixmethod.workers.dev
4. Enter your test email → click Send me my link
5. Check your inbox for the Phoenix-branded magic link (if it's not there in ~30 sec, check spam)
6. Click the link → you should land at `/smith/` with the new client's portal content loaded

If anything's broken, run `wrangler tail` in the portal folder to see live logs while you retry.

**Remove your test entry from the allowlist** once you've confirmed the flow works.

---

## Step 5 — Onboard the client

Send them a welcome email from your hello@phoenixmethodseo.com (or kandyphoenix@hotmail.com) address. Template:

```
Subject: Your Phoenix Method client portal is ready

Hi [Name],

Welcome to Phoenix Method. Your client portal is ready — this is where you'll find
rankings, deliverables, reports, and everything we're doing for you month-to-month.

To sign in:
1. Go to https://portal.phoenixmethod.workers.dev
2. Enter your email ([their-email])
3. Check your inbox for a sign-in link
4. Click it → you're in

Bookmark the page. You'll stay logged in for 7 days, so after the first sign-in
you won't see the login screen often.

Questions about anything — just reply to this email.

— Kandy
Phoenix Method
hello@phoenixmethodseo.com
```

---

## Updating a client's portal later

When you want to update their content:

1. Edit the files in `workers/portal/public/{slug}/` (usually `data.json`)
2. `cd` into `workers/portal` and run `wrangler deploy`

Takes ~10 seconds. Client sees the new content next time they refresh.

---

## Removing a client's access

1. Dashboard → KV → ALLOWLIST → find their email row → delete it
2. Optional: delete the `workers/portal/public/{slug}/` folder and redeploy if you want to remove the content entirely

They can't sign in anymore; any old session cookie will expire within 7 days.

---

## Things to never put in a client portal

- Their credit card or billing details (we don't store these; they pay via Square direct link)
- Your internal credentials, API keys, or passwords
- PHI or HIPAA-regulated data (the portal is not built to HIPAA standards)
- Other clients' information

Progress reports, rankings, deliverables, scheduled work, SEO audits, content calendars, invoices you've already sent — all fine.

---

## Architecture reference (so you understand what you built)

- **One Cloudflare Worker** (`portal`) handles sign-in for every client
- **URL:** https://portal.phoenixmethod.workers.dev
- **Auth:** email magic-link via Resend, HMAC-signed session tokens, 7-day HttpOnly cookie
- **Allowlist:** Cloudflare KV namespace `ALLOWLIST`, one entry per authorized email
- **Content:** per-client folders under `workers/portal/public/{slug}/`
- **Rate limit:** 3 sign-in requests per IP per 10 minutes
- **Email from:** hello@phoenixmethodseo.com (via Resend, SPF + DKIM at WordPress.com DNS)
- **Secrets stored in the worker:**
  - `RESEND_API_KEY` — Resend API key
  - `SESSION_SECRET` — HMAC key for signing tokens

Every client is isolated from every other client. Even if someone guessed another client's slug, the worker checks their session against the slug they're requesting and blocks cross-client access.

---

## Emergency: what to do if something breaks

1. **Email isn't arriving** — run `wrangler tail` in `workers/portal` while the client retries. Most common cause: email in spam folder. Second most common: Resend SPF check failing (verify the WordPress SPF record still has `include:amazonses.com`).
2. **"Unable to load portal data"** — the client's `data.json` is either missing or malformed. Check `workers/portal/public/{slug}/data.json`.
3. **Client can sign in but lands at a blank page** — their content folder doesn't exist or is empty. Check `workers/portal/public/{slug}/index.html`.
4. **Everything is broken for everyone** — check the worker is deployed: https://dash.cloudflare.com → Workers & Pages → `portal` → recent deployments. If it was accidentally deleted, redeploy with `wrangler deploy` from `workers/portal`.
5. **I lost the SESSION_SECRET** — all existing sessions will invalidate, but you can just generate a new one and `wrangler secret put SESSION_SECRET` to continue. Clients will need to sign in again.
