# Portal Link Worker

Cloudflare Worker that emails clients a magic link to their portal when they request access at `/portal/`.

## How it works

1. Client visits `https://phoenixmethodseo.com/portal/`, enters email, clicks **Send Me My Link**.
2. Browser POSTs `{ email }` to `https://portal-link.phoenixmethodseo.com/request`.
3. Worker checks the `ALLOWLIST` KV namespace for that email.
   - If present, sends a branded email (via MailChannels — free through Cloudflare Workers) with the portal URL.
   - If not present, silently returns success (no account enumeration).
4. Worker always responds `200 { ok: true }` to the browser.

Rate limit: **3 requests per IP per 10 minutes** (KV-backed). Excess requests return the same generic 200 so an attacker can't probe.

## One-time setup

**1. Install Wrangler** (Cloudflare's CLI):
```
npm install -g wrangler
wrangler login
```

**2. Create the KV namespaces:**
```
cd workers/portal-link
wrangler kv:namespace create ALLOWLIST
wrangler kv:namespace create RATE_LIMIT
```
Paste the two `id` values Wrangler prints into `wrangler.toml` (replacing the `REPLACE_WITH_*` placeholders).

**3. Deploy the Worker:**
```
wrangler deploy
```
This publishes the Worker and binds it to `portal-link.phoenixmethodseo.com/*`.

**4. DNS — route the subdomain:**
In Cloudflare DNS for `phoenixmethodseo.com`, add a proxied record (orange cloud):
```
Type   Name           Content                     Proxy
CNAME  portal-link    phoenixmethodseo.com        Proxied
```
Wrangler will hook the Worker onto that hostname.

**5. DNS — MailChannels authorization** (prevents other tenants from spoofing your domain):
Add a TXT record:
```
Type   Name                Content
TXT    _mailchannels       v=mc1 cfid=phoenixmethodseo.com
```
(The exact `cfid` value is your Cloudflare account email domain — the one attached to your CF account. See https://support.mailchannels.com/hc/en-us/articles/16918954360845 for current guidance.)

**6. SPF** — make sure your SPF record includes MailChannels:
```
Type   Name    Content
TXT    @       v=spf1 include:relay.mailchannels.net ~all
```
(If you already have SPF for Outlook/Google/etc., add `include:relay.mailchannels.net` to it — don't create a second record.)

**7. DKIM (recommended but optional)** — sign outgoing messages so they pass Gmail/Outlook DKIM checks. MailChannels docs walk you through generating a keypair and adding the public key as a TXT record.

## Managing the allowlist

Each entry maps a client's login email → their portal path.

**Add a client:**
```
wrangler kv:key put --binding=ALLOWLIST "kandy@phwcare.com" '{"path":"/portal/phw/","name":"Kandy"}'
```

The value can be:
- A plain string (the portal path): `"/portal/phw/"`
- A JSON object with `path` and optional `name`: `{"path":"/portal/phw/","name":"Kandy"}`

Use the name form when you want the email greeting to say "Hi Kandy".

**Remove a client:**
```
wrangler kv:key delete --binding=ALLOWLIST "kandy@phwcare.com"
```

**List current clients:**
```
wrangler kv:key list --binding=ALLOWLIST
```

You can also do all of this through the Cloudflare dashboard at **Workers & Pages → KV → ALLOWLIST**.

## Local development

```
wrangler dev
```
Runs the Worker at `http://localhost:8787`. Update `ENDPOINT` in `/portal/index.html` temporarily if you want to test end-to-end locally.

## Troubleshooting

- **Emails not arriving** — check spam; verify SPF includes `relay.mailchannels.net`; check Worker logs: `wrangler tail`.
- **CORS error in browser** — the allowed origins are hardcoded in `worker.js` (`ALLOWED_ORIGINS`). Add any new origin there and redeploy.
- **Rate limit hitting you while testing** — `wrangler kv:key delete --binding=RATE_LIMIT "rl:YOUR_IP"`.
