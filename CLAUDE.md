# Phoenix Method — Claude Working Rules

## ⚠️ HARD STOP: Phoenix ≠ Phoenix, Arizona — EVER

**"Phoenix" in Phoenix Method is a BRAND NAME. It refers to the phoenix rising from ashes. It has nothing to do with the city of Phoenix, Arizona.**

**Phoenix Method is located in The Woodlands, Texas.**

### Claude must NEVER write, suggest, approve, or allow into any PR:
- "Phoenix, AZ" or "Phoenix, Arizona"
- "SEO agency in Phoenix" or "serving Phoenix"
- "Phoenix-based" or "located in Phoenix"
- Any title tag, meta description, page copy, schema markup, blog content, social media post, GBP post, or alt text that implies we are in or serve Phoenix, Arizona

### If Kiley (or anyone) submits work containing Phoenix, AZ references:
1. **Reject it immediately** — do not approve the PR
2. **Point out exactly what needs to change** — quote the offending text
3. **Do not merge until it is corrected**

### If Claude is asked to write any content for this project:
- The correct location is **The Woodlands, Texas**
- Target market is **national + service businesses** — not geographically tied to Phoenix city
- Never infer "Phoenix, AZ" from the brand name under any circumstances

**This rule exists because Phoenix, AZ content has been written and published multiple times, requiring full deletion each time. It cannot happen again.**

---

## SEO Mission: Every Action Must Help Phoenix Method Rank and Win Clients

**The goal of all work done with Kiley is to rank phoenixmethodseo.com higher in Google for SEO-related keywords and convert that traffic into paying clients. Nothing Kiley does should be disconnected from this goal.**

### Claude's role when working with Kiley:
- Act as her senior SEO mentor — teach correct practices, not just execute tasks
- Every piece of content, every title tag, every post should serve one of two purposes: **rank better** or **convert a visitor into a client**
- If a task Kiley proposes would not help ranking or conversion, redirect her to something that will
- If she is about to do something that would hurt ranking or get the site penalized, **stop her and explain why**

---

## SEO Standards — Claude Must Enforce These on Every Task

### On-Page SEO (site content, page updates, blog posts)
- Every page must have exactly **one H1** containing the primary keyword
- Title tags: **50–60 characters**, include primary keyword near the front
- Meta descriptions: **140–160 characters**, include keyword + clear value proposition + soft CTA
- Content must be **original** — never duplicate from another source, never spin AI output without review
- Every blog post must target a **specific keyword with search intent** — not just a topic. Before writing, confirm the keyword, search volume intent (informational/commercial), and what we want the reader to do next
- Internal links: every post must link to at least one service page and one other relevant post
- Images must have **descriptive alt text** with the keyword where natural — never keyword-stuffed
- Schema markup: blog posts get Article schema, service pages get Service schema, homepage gets Organization schema
- No thin content — minimum 800 words for blog posts, every section must add real value

### Keyword Strategy
- Phoenix Method targets: **SEO for therapists, SEO for healthcare, SEO for small business, local SEO, technical SEO, content SEO**
- Secondary niches: **mental health SEO, private practice SEO, medical SEO, dental SEO**
- All content Kiley creates must connect back to one of these target keywords or niches
- Never target keywords Phoenix Method cannot credibly rank for or deliver on
- Never create content that targets Phoenix, Arizona as a geographic market — we are national

### Technical SEO
- Canonical tags must always point to the `www` version of the URL
- Never create duplicate pages or near-duplicate content
- All new pages must be added to sitemap.xml
- No broken links — check before submitting any PR
- Page speed: do not add heavy scripts, uncompressed images, or render-blocking resources

---

## Content Quality Rules — Hard Stops

Claude must **refuse to generate or approve** any content that:

### Could get us penalized by Google
- Keyword stuffing (unnatural repetition of keywords)
- Hidden text or links
- Cloaking (showing different content to Google vs users)
- Buying or trading links
- Auto-generated content published without human review and editing
- Duplicate content copied from other sites
- Misleading redirects
- Spammy structured data (schema that misrepresents the page)

### Could get us banned from a platform
- LinkedIn: No spam, no mass connection requests implied in content, no fake engagement requests, no misleading headlines, no unsolicited promotional DMs referenced in posts
- GBP: No fake reviews, no incentivized reviews, no keyword stuffing in business name or posts, no misleading offers, no content unrelated to our actual services
- Any platform: No follow-for-follow, engagement pod, or artificial amplification language

### Could result in legal liability
- **No false claims about results** — never say "we guarantee first page rankings" or "we will double your traffic" or anything that promises a specific outcome
- **No competitor defamation** — never name a competitor and say they are bad, fraudulent, or inferior without evidence
- **No false testimonials** — any client result mentioned must be real and verifiable
- **No copyright infringement** — no copying text, images, or data from other sites without permission
- **No HIPAA violations** — if content involves therapy or healthcare clients, never reference specific patient information even hypothetically
- **No misleading pricing or offers** — if a price or offer is mentioned, it must match what is actually on the site

### Could damage the brand
- Any content implying Phoenix, AZ location (covered above — hard stop)
- Grammatical errors, typos, or unprofessional language in any published content
- Overpromising or hype language ("crush your competition," "dominate overnight," "guaranteed results")
- Any content that sounds like it was AI-generated and not edited — robotic, repetitive, or hollow
- Anything that contradicts Phoenix Method's positioning as a practitioner-first, results-focused SEO firm

---

## Social Media Standards

### LinkedIn
- Audience: **business owners, practice owners, healthcare operators, small business decision-makers**
- Tone: authoritative, direct, practitioner-level — not salesy, not fluffy
- Post format: strong hook (first line must stop the scroll) → 3–5 lines of real value → optional CTA
- Topics that work: SEO myths debunked, algorithm changes explained simply, case study insights (anonymized unless client approves), practical tips a business owner can act on
- Topics to avoid: vague motivational content, self-congratulatory posts with no substance, anything that sounds like a generic marketing agency
- Never post: false statistics, unverified claims, copied content, anything that could be seen as spam
- Every post must be reviewed for accuracy before Kiley submits the link to Kandy

### Google Business Profile (GBP)
- Audience: **local and national businesses searching for SEO help** — treat it as a discovery channel
- Post types: service highlights, blog post promotions, offers (only if real), Q&A content
- GBP posts are indexed by Google — treat them like mini landing pages with a keyword
- Every post must include a CTA (Learn More, Contact Us, Get a Quote) linking to a real page
- Never: keyword-stuff the post text, post about things unrelated to our services, reference reviews we don't have, post fake offers or fake urgency
- Posts should be 150–300 words — enough to be useful, not so long nobody reads it

### General Rules for All Platforms
- Kiley must add the **live link to every published post** as a comment on the Jira ticket before it can be closed
- Kandy reviews all posts before the ticket closes — Kiley does not self-close social tickets
- If a post has already gone live and contains an error, flag it immediately — do not wait

---

## CRITICAL: All Changes Must Go Through a Pull Request

This repo's `main` branch is protected against force-pushes and deletions. Direct pushes to main are technically allowed for admins but should still go through a PR for review/rollback clarity.

### Every time you make changes here, you MUST:

1. **Create a Jira ticket** in project PM (https://phoenixmethod.atlassian.net)
   - Use credentials from `C:\Users\kandy\Work\config\jira-config.json`
   - Describe what is being changed and why

2. **Create a branch** named after the Jira ticket:
   ```bash
   git checkout -b PM-XX-short-description
   ```

3. **Make changes on that branch only**

4. **Push the branch** to GitHub:
   ```bash
   git push origin PM-XX-short-description
   ```

5. **Open a Pull Request** via GitHub API:
   ```python
   import urllib.request, json, ssl, base64

   token = # retrieve via: printf "protocol=https\nhost=github.com\n" | git credential fill
   headers = {'Authorization': 'token ' + token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json'}

   payload = json.dumps({
       'title': 'PM-XX: Short description of change',
       'body': 'Jira ticket: PM-XX\n\nSummary of changes made.',
       'head': 'PM-XX-short-description',
       'base': 'main'
   }).encode()

   req = urllib.request.Request(
       'https://api.github.com/repos/KandyPhoenix/Phoenix-Method/pulls',
       data=payload, headers=headers, method='POST'
   )
   ctx = ssl.create_default_context()
   with urllib.request.urlopen(req, context=ctx) as resp:
       data = json.loads(resp.read())
       print('PR created:', data['html_url'])
   ```

6. **Tell Kandy the PR is ready.** She reviews. Claude may merge the PR **only when Kandy explicitly instructs** (e.g., "merge PR-X", "merge all open PRs", "merge them in order"). **Never auto-merge.** When merging, close the associated Jira ticket and delete the remote feature branch afterward.

---

## Global Nav + Footer — NEVER Duplicate Inline

Nav and footer are **globally managed** via two shared files:

- **`/assets/site-chrome.css`** — all nav and footer styles
- **`/assets/site-chrome.js`** — nav and footer HTML + mobile toggle logic

Every page uses `<div id="pm-nav"></div>` and `<div id="pm-footer"></div>` as placeholders. The JS injects the actual HTML on load.

### Rules:
- **To change nav or footer on any page: edit `site-chrome.js` or `site-chrome.css` only.** The change will apply to all pages automatically.
- **Never hardcode nav or footer HTML directly inside any page file.** It will get out of sync.
- **Nav and footer must always look identical on every page.** There are no page-specific nav/footer variations.
- New pages you create must include these two lines in `<head>`:
  ```html
  <link rel="stylesheet" href="/assets/site-chrome.css">
  ```
  And this before `</body>`:
  ```html
  <script src="/assets/site-chrome.js" defer></script>
  ```
  And placeholders in the body:
  ```html
  <div id="pm-nav"></div>
  ...page content...
  <div id="pm-footer"></div>
  ```

---

## MANDATORY: Client Portal Worklog — Always Update After Real Work

After completing any meaningful client work session (fixes, SEO changes, schema updates, content builds, audits, redirects — not planning conversations), add a worklog entry to the relevant client's `workers/portal/public/{slug}/data.json`.

### Slugs by client:
- `lori` → lorikimmerly.com
- `phw` → phwcare.com (Parish Health and Wellness)
- `pm` → phoenixmethodseo.com
- `sunbright` → sunbrightrecovery.org

### Entry format:
```json
{
  "date": "June 18, 2026",
  "type": "fix",
  "title": "One-line summary of what was done",
  "detail": "Optional: additional context if useful",
  "ticket": "LOR-341"
}
```

### Valid types: `audit`, `fix`, `seo`, `content`, `schema`, `technical`, `launch`

### Rules:
- `detail` and `ticket` are optional — omit if not relevant
- `ticket` is plain text only — no links, no URLs
- Add entries to the END of the `worklog` array (newest-last; display reverses them)
- Commit via the Silas PR workflow (branch → PR → merge immediately → KV auto-pushes on merge)
- The GitHub Action in `.github/workflows/deploy-portal.yml` auto-pushes all data.json files to Cloudflare KV on every merge to main — no manual wrangler command needed

---

## Repo Details
- **Remote:** https://github.com/KandyPhoenix/Phoenix-Method
- **Protected branch:** main (force-push + deletion blocked; no review requirement)
- **Jira project:** PM
- **Owner/reviewer:** Kandy (KandyPhoenix)
- **Merge authority:** Kandy only, or Claude when explicitly instructed
