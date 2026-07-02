import json

# ── Read master template ──────────────────────────────────────────────────────
with open('workers/portal/public/lori/index.html', encoding='utf-8') as f:
    html = f.read()

# ── 1. CSS ────────────────────────────────────────────────────────────────────
OLD_CSS = '        @media (max-width:480px) { .links-grid { grid-template-columns: 1fr; } }'
NEW_CSS = OLD_CSS + """

        /* ── WORKLOG ── */
        .worklog-list { display: flex; flex-direction: column; gap: 0; }
        .worklog-entry {
            display: flex; gap: 14px; padding: 14px 0;
            border-bottom: 0.5px solid rgba(255,255,255,0.05);
        }
        .worklog-entry:last-child { border-bottom: none; }
        .worklog-left { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; width: 90px; }
        .worklog-date { font-size: 11px; color: #5E5A6B; white-space: nowrap; text-align: right; margin-top: 2px; }
        .worklog-type {
            font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 4px;
            text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap;
        }
        .wt-audit     { background: rgba(52,152,219,0.15);  color: #3498db; }
        .wt-fix       { background: rgba(255,140,0,0.15);   color: #C9922A; }
        .wt-seo       { background: rgba(59,175,191,0.15);  color: #3bafbf; }
        .wt-content   { background: rgba(155,89,182,0.15);  color: #9b59b6; }
        .wt-schema    { background: rgba(39,174,96,0.15);   color: #27ae60; }
        .wt-technical { background: rgba(94,90,107,0.18);   color: #9A95A8; }
        .wt-launch    { background: rgba(240,192,64,0.15);  color: #c9a020; }
        .worklog-body { flex: 1; min-width: 0; }
        .worklog-title { font-size: 13px; color: #F0ECE6; font-weight: 500; line-height: 1.4; }
        .worklog-detail { font-size: 12px; color: #7A7588; margin-top: 3px; line-height: 1.5; }
        .worklog-ticket {
            display: inline-block; margin-top: 5px;
            font-size: 10px; font-weight: 600; color: #5E5A6B;
            background: rgba(255,255,255,0.04); border: 0.5px solid rgba(255,255,255,0.08);
            border-radius: 4px; padding: 1px 6px; letter-spacing: 0.3px;
        }"""
html = html.replace(OLD_CSS, NEW_CSS)
print('CSS:', '.worklog-list' in html)

# ── 2. JS builder ─────────────────────────────────────────────────────────────
OLD_JS = '    // ── SITE LINKS ──'
NEW_JS = r"""    // ── WORKLOG ──
    const worklog = d.worklog || [];
    const wtLabel = { audit: 'Audit', fix: 'Fix', seo: 'SEO', content: 'Content', schema: 'Schema', technical: 'Technical', launch: 'Launch' };
    const worklogHtml = worklog.length
        ? '<div class="worklog-list">' + [...worklog].reverse().map(e => `
            <div class="worklog-entry">
                <div class="worklog-left">
                    <div class="worklog-date">${e.date}</div>
                    <span class="worklog-type wt-${e.type || 'fix'}">${wtLabel[e.type] || e.type}</span>
                </div>
                <div class="worklog-body">
                    <div class="worklog-title">${e.title}</div>
                    ${e.detail ? `<div class="worklog-detail">${e.detail}</div>` : ''}
                    ${e.ticket ? `<span class="worklog-ticket">${e.ticket}</span>` : ''}
                </div>
            </div>`).join('') + '</div>'
        : '<p style="color:#9A95A8;font-size:13px;padding:16px 0">Work log entries will appear here as tasks are completed.</p>';

    // ── SITE LINKS ──"""
html = html.replace(OLD_JS, NEW_JS)
print('JS:', 'worklogHtml' in html)

# ── 3. Tab button ─────────────────────────────────────────────────────────────
OLD_TAB = '<button class="tab" data-tab="links">Site Links</button>'
NEW_TAB = '<button class="tab" data-tab="worklog">Work Log</button>\n            <button class="tab" data-tab="links">Site Links</button>'
html = html.replace(OLD_TAB, NEW_TAB)
print('Tab:', 'data-tab="worklog"' in html)

# ── 4. Section ────────────────────────────────────────────────────────────────
OLD_SEC = '        <!-- SITE LINKS -->'
NEW_SEC = """        <!-- WORKLOG -->
        <div class="section" id="sec-worklog">
            <div class="sec-header">
                <span class="sec-title">Work Log</span>
                <span class="sec-sub">Completed tasks, audits &amp; fixes</span>
            </div>
            ${worklogHtml}
        </div>

        <!-- SITE LINKS -->"""
html = html.replace(OLD_SEC, NEW_SEC)
print('Section:', 'sec-worklog' in html)

# ── Write to all portals ──────────────────────────────────────────────────────
for slug in ['lori', 'phw', 'pm', 'sunbright']:
    with open(f'workers/portal/public/{slug}/index.html', 'w', encoding='utf-8') as f:
        f.write(html)
print('HTML written to all 4 portals')

# ── LORI worklog data ─────────────────────────────────────────────────────────
with open('workers/portal/public/lori/data.json', encoding='utf-8') as f:
    lori = json.load(f)

lori['worklog'] = [
    {
        "date": "May 10, 2026", "type": "technical",
        "title": "12 retired portfolio URLs redirected to Meet the Team",
        "detail": "Old Avada demo pages (cardiology, pediatrics, ultrasound) permanently deleted and 301-redirected."
    },
    {
        "date": "May 10, 2026", "type": "fix",
        "title": "3 duplicate/old therapist slugs redirected",
        "detail": "Old Ryan Carragher URL + Faynesha Haragan and Keziah Grindeland former-therapist pages closed."
    },
    {
        "date": "May 10, 2026", "type": "seo",
        "title": "Meta title + description rewrites — Lori bio, contact, Meet the Team",
        "detail": "Lori bio rebuilt around 'Online Therapist' intent. Contact and team page titles tightened for CTR."
    },
    {
        "date": "May 10, 2026", "type": "technical",
        "title": "~20 auto-generated FAQ pages noindexed + removed from sitemap",
        "detail": "Thin pages duplicating FAQ schema on contact page. Pulled from Google's coverage report."
    },
    {
        "date": "May 10, 2026", "type": "schema",
        "title": "Person schema rebuilt on all therapist bio pages",
        "detail": "Full credentials, license info, specialties, Psychology Today links. Lori's bio includes AZ service area."
    },
    {
        "date": "May 10, 2026", "type": "schema",
        "title": "WebSite + SearchAction schema added sitewide",
        "detail": "Enables sitelinks search box on brand searches. Sitemap submitted, www GSC property removed."
    },
    {
        "date": "May 10, 2026", "type": "content",
        "title": "Iwona Abraham + Devi Viswanathan onboarded",
        "detail": "Full bio pages, homepage carousel, Meet the Team, mega menu, contact form dropdown, schema. John Hubbs credentials updated to fully licensed."
    },
    {
        "date": "May 12, 2026", "type": "fix",
        "title": "SilentShield plugin replaced with honeypot — contact forms restored",
        "detail": "Plugin was blocking all form submissions. Both main contact and in-page booking forms verified working.",
        "ticket": "LOR-325"
    },
    {
        "date": "May 12, 2026", "type": "content",
        "title": "Session rates updated — Devi + Iwona bio pages",
        "detail": "Corrected listed fees on both therapist bios.",
        "ticket": "LOR-324 LOR-326"
    },
    {
        "date": "May 21, 2026", "type": "fix",
        "title": "Bio hero layout fixed — Lori + Kristen pages",
        "detail": "Hero card was rendering behind nav bar. Root cause: padding too low for 155px fixed header. Updated to match Jared's working layout.",
        "ticket": "LOR-333"
    },
    {
        "date": "June 9, 2026", "type": "seo",
        "title": "Insurance blog title rewrite — CTR improvement",
        "detail": "Position 8 with 84 impressions, 1 click (1.2% CTR). New title leads with insurance hook.",
        "ticket": "LOR-334"
    },
    {
        "date": "June 9, 2026", "type": "schema",
        "title": "24 structured data warnings resolved — breadcrumb + FAQ",
        "detail": "Breadcrumb position field was string not integer (20 warnings). FAQ answer text included raw HTML (4 warnings). Fixed via mu-plugin rewriting JSON-LD before browser.",
        "ticket": "LOR-335 LOR-336"
    },
    {
        "date": "June 9, 2026", "type": "seo",
        "title": "About Therapists page title regression corrected",
        "detail": "'Online Counseling' had replaced 'Online Therapy' in title — impressions had dropped from 1,293 to 397. Restored to: Online Therapy Washington | Licensed Therapists WA."
    },
    {
        "date": "June 9, 2026", "type": "seo",
        "title": "Bio title rewrites — Jennifer Kenworthy, Sheena Nicolay, Devi Viswanathan",
        "detail": "'MFT Intern' was leading title tags — reduced CTR. Titles now service-first, leading with each therapist's specialty."
    },
    {
        "date": "June 18, 2026", "type": "fix",
        "title": "Comments disabled site-wide",
        "detail": "Closed comments and pingbacks on all 5 existing posts. Site default set to closed for future posts."
    }
]

with open('workers/portal/public/lori/data.json', 'w', encoding='utf-8') as f:
    json.dump(lori, f, indent=2, ensure_ascii=False)
print(f'Lori worklog: {len(lori["worklog"])} entries')

# ── PHW worklog data ──────────────────────────────────────────────────────────
with open('workers/portal/public/phw/data.json', encoding='utf-8') as f:
    phw = json.load(f)

phw['worklog'] = [
    {
        "date": "April 2026", "type": "audit",
        "title": "Full technical SEO audit completed",
        "detail": "Schema, alt text, title tags, heading hierarchy, Core Web Vitals — full findings documented."
    },
    {
        "date": "April 2026", "type": "schema",
        "title": "Schema markup implemented — LocalBusiness, MedicalBusiness, FAQPage, BreadcrumbList",
        "ticket": "PHW Phase 1"
    },
    {
        "date": "April 2026", "type": "seo",
        "title": "Title tags + meta descriptions optimized site-wide",
        "detail": "All 10 therapy service pages updated — titles, metas, schema."
    },
    {
        "date": "April 2026", "type": "fix",
        "title": "Image alt text fixed site-wide"
    },
    {
        "date": "April 2026", "type": "fix",
        "title": "Heading hierarchy corrected — one H1 per page"
    },
    {
        "date": "April 2026", "type": "content",
        "title": "Red Bluff location page built — /therapy-red-bluff-ca live"
    },
    {
        "date": "April 2026", "type": "seo",
        "title": "Online therapy page SEO updated — /online-therapy-california"
    },
    {
        "date": "June 9, 2026", "type": "fix",
        "title": "Stale redirect corrected — wrong destination fixed",
        "ticket": "PHW-253"
    },
    {
        "date": "June 9, 2026", "type": "fix",
        "title": "FAQ schema warnings resolved — CSS max-height was hiding answers from Google",
        "detail": "Fixed on /therapy-red-bluff-ca and /online-therapy-california. Sitemap resubmitted."
    },
    {
        "date": "June 9, 2026", "type": "seo",
        "title": "Online therapy page title rewrite — 9,441 impressions at pos 29, 0.08% CTR",
        "detail": "New title: 'Online Therapy California | Medi-Cal & Insurance Accepted'. Surfaces key differentiator."
    },
    {
        "date": "June 9, 2026", "type": "fix",
        "title": "Blog post republished — /mental-health-blog/how-online-therapy-works-in-california",
        "detail": "Page had been set to Draft — live 404 with 15,765 impressions in last 90 days. Republished + title updated."
    },
    {
        "date": "June 9, 2026", "type": "seo",
        "title": "Couples therapy blog title rewrite — /mental-health-blog/couples-therapy-california",
        "detail": "New title surfaces telehealth + same-week availability. 7,650 impressions/mo at pos 35.",
        "ticket": "PHW-260"
    }
]

with open('workers/portal/public/phw/data.json', 'w', encoding='utf-8') as f:
    json.dump(phw, f, indent=2, ensure_ascii=False)
print(f'PHW worklog: {len(phw["worklog"])} entries')

# ── PM worklog data ───────────────────────────────────────────────────────────
with open('workers/portal/public/pm/data.json', encoding='utf-8') as f:
    pm = json.load(f)

pm['worklog'] = [
    {
        "date": "May 2, 2026", "type": "audit",
        "title": "First site audit + GSC baseline established",
        "detail": "April baseline: 90 impressions, 1 click, avg position 9.8, 25 keyword queries. Homepage meta trimmed to under 165 chars.",
        "ticket": "PM-144"
    },
    {
        "date": "May 2026", "type": "launch",
        "title": "6 service pages built and indexed",
        "detail": "ai-overview-optimization, content-seo, gbp-optimization, local-seo, seo-development, technical-seo all live."
    },
    {
        "date": "May 2026", "type": "technical",
        "title": "Canonical tags — all pages canonicalized to www",
        "ticket": "PM-277"
    },
    {
        "date": "June 1, 2026", "type": "audit",
        "title": "May GSC checkpoint — 652 impressions, 73 keywords",
        "detail": "6.7x impression growth from April. 73 keyword queries vs 35 in April. Average position 73.7 (new content in deep positions — expected)."
    }
]

with open('workers/portal/public/pm/data.json', 'w', encoding='utf-8') as f:
    json.dump(pm, f, indent=2, ensure_ascii=False)
print(f'PM worklog: {len(pm["worklog"])} entries')

# ── Sunbright worklog data ────────────────────────────────────────────────────
with open('workers/portal/public/sunbright/data.json', encoding='utf-8') as f:
    sb = json.load(f)

sb['worklog'] = [
    {
        "date": "June 6, 2026", "type": "launch",
        "title": "Homepage built — all 13 sections complete",
        "detail": "Hero, programs, about, what we treat, daily schedule, donation/volunteer, FAQ, and footer. Deployed to Cloudflare Pages preview."
    },
    {
        "date": "June 6, 2026", "type": "launch",
        "title": "Admissions page mockup built",
        "detail": "Draft at /admissions-preview on Cloudflare Pages. Pending form backend decision before finalizing."
    }
]

with open('workers/portal/public/sunbright/data.json', 'w', encoding='utf-8') as f:
    json.dump(sb, f, indent=2, ensure_ascii=False)
print(f'Sunbright worklog: {len(sb["worklog"])} entries')
