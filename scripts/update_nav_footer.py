"""
Updates all Phoenix Method sub-pages with the full dropdown nav and standard footer.
Run from: C:/Users/kandy/PHOENIX METHOD/
"""
import re, os, sys

ROOT = "C:/Users/kandy/PHOENIX METHOD"

PAGES = [
    "small-business-seo/index.html",
    "small-business-seo-pricing/index.html",
    "services/local-seo/index.html",
    "services/technical-seo/index.html",
    "services/content-seo/index.html",
    "services/gbp-optimization/index.html",
    "services/ai-overview-optimization/index.html",
    "services/seo-development/index.html",
    "industries/healthcare-seo/index.html",
    "industries/mental-health-seo/index.html",
    "industries/dental-seo/index.html",
    "industries/agriculture-seo/index.html",
    "industries/oil-gas-seo/index.html",
    "plans/spark/index.html",
    "plans/blaze/index.html",
    "plans/inferno/index.html",
    "order.html",
    "confirmation.html",
    "get-started.html",
    "service-intake.html",
]

NAV_CSS = """
    /* ========== NAV ========== */
    .nav { position: fixed; top: 0; left: 0; right: 0; z-index: 1000; padding: 20px 0; background: rgba(7,7,13,0.92); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border); transition: all 0.4s ease; }
    .nav-inner { max-width: var(--container-max, 1200px); margin: 0 auto; padding: 0 var(--side-padding, 24px); display: flex; align-items: center; justify-content: space-between; }
    .nav-logo { display: flex; align-items: center; }
    .nav-logo-img { height: 60px; width: auto; object-fit: contain; }
    .nav-links { display: flex; align-items: center; gap: 22px; list-style: none; flex-wrap: nowrap; }
    .nav-links > li { white-space: nowrap; }
    .nav-links a { font-family: var(--font-accent, 'Rajdhani', sans-serif); font-weight: 500; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; color: #C8C5D4; transition: color 0.3s; }
    .nav-links a:hover { color: var(--fire-mid, #FF8C00); }
    .nav-dropdown { position: relative; }
    .nav-dropdown > a::after { content: ' ▾'; font-size: 0.7em; opacity: 0.6; }
    .nav-dropdown-menu { position: absolute; top: calc(100% + 12px); left: -16px; min-width: 240px; background: rgba(14,14,24,0.98); border: 1px solid var(--border, rgba(255,77,0,0.12)); border-radius: 10px; padding: 8px 0; opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity .2s, transform .2s, visibility .2s; backdrop-filter: blur(12px); list-style: none; }
    .nav-dropdown.dropdown-right .nav-dropdown-menu { left: auto; right: -16px; }
    .nav-dropdown:hover .nav-dropdown-menu, .nav-dropdown:focus-within .nav-dropdown-menu { opacity: 1; visibility: visible; transform: translateY(0); }
    .nav-dropdown-menu li { display: block; }
    .nav-dropdown-menu a { display: block; padding: 10px 20px; font-size: 0.82rem; color: #C8C5D4; text-transform: none; letter-spacing: 0.04em; }
    .nav-dropdown-menu a:hover { color: var(--fire-mid, #FF8C00); background: rgba(255,140,0,0.05); }
    .nav-cta { padding: 10px 24px !important; border: 1px solid var(--fire-start, #FF4D00) !important; border-radius: 4px; color: var(--fire-mid, #FF8C00) !important; }
    .nav-cta:hover { background: var(--fire-start, #FF4D00) !important; color: #fff !important; }
    .nav-toggle { display: none; flex-direction: column; gap: 5px; background: none; border: none; cursor: pointer; padding: 8px; }
    .nav-toggle span { width: 24px; height: 2px; background: #F0ECE6; border-radius: 2px; }
    @media (max-width: 900px) {
        .nav-links { display: none; flex-direction: column; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(7,7,13,0.98); padding: 100px 40px 40px; gap: 8px; z-index: 999; overflow-y: auto; }
        .nav-links.open { display: flex; }
        .nav-links > li { width: 100%; }
        .nav-links a { font-size: 1.1rem; padding: 12px 0; display: block; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .nav-dropdown-menu { position: static; opacity: 1; visibility: visible; transform: none; background: transparent; border: none; padding: 0 0 0 16px; }
        .nav-dropdown > a::after { content: none; }
        .nav-toggle { display: flex; z-index: 1000; }
    }"""

FOOTER_CSS = """
    /* ========== FOOTER ========== */
    .footer { padding: 60px 0 30px; border-top: 1px solid rgba(255,255,255,0.06); }
    .footer-inner { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; gap: 40px; margin-bottom: 40px; align-items: start; }
    .footer-brand { display: flex; flex-direction: column; gap: 12px; }
    .footer-tagline { color: var(--text-muted, #5E5A6B); font-size: 0.9rem; line-height: 1.6; }
    .footer-links { display: contents; }
    .footer-col { display: flex; flex-direction: column; gap: 10px; }
    .footer-col h4 { font-family: var(--font-accent, 'Rajdhani', sans-serif); font-weight: 600; font-size: 0.8rem; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 8px; }
    .footer-col a { color: var(--text-muted, #5E5A6B); font-size: 0.9rem; transition: color 0.3s; }
    .footer-col a:hover { color: var(--fire-mid, #FF8C00); }
    .footer-bottom { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 24px; text-align: center; }
    .footer-bottom p { color: var(--text-muted, #5E5A6B); font-size: 0.8rem; }
    @media (max-width: 900px) { .footer-inner { grid-template-columns: 1fr; text-align: center; } }"""

NAV_HTML = """    <nav class="nav" id="nav">
        <div class="nav-inner">
            <a href="https://phoenixmethodseo.com/" class="nav-logo" aria-label="Phoenix Method Home">
                <img src="https://phoenixmethodseo.com/assets/phoenix-full-logo.png" alt="Phoenix Method" class="nav-logo-img" width="1077" height="502">
            </a>
            <button class="nav-toggle" id="navToggle" aria-label="Toggle menu">
                <span></span><span></span><span></span>
            </button>
            <ul class="nav-links" id="navLinks">
                <li class="nav-dropdown">
                    <a href="/small-business-seo/">Services</a>
                    <ul class="nav-dropdown-menu">
                        <li><a href="/small-business-seo/"><strong>Small Business SEO</strong></a></li>
                        <li><a href="/services/local-seo/">Local SEO</a></li>
                        <li><a href="/services/technical-seo/">Technical SEO</a></li>
                        <li><a href="/services/content-seo/">Content SEO</a></li>
                        <li><a href="/services/gbp-optimization/">GBP Optimization</a></li>
                        <li><a href="/services/ai-overview-optimization/">AI Overview Optimization</a></li>
                        <li><a href="/services/seo-development/">SEO Development</a></li>
                    </ul>
                </li>
                <li class="nav-dropdown">
                    <a href="/small-business-seo/">Industries</a>
                    <ul class="nav-dropdown-menu">
                        <li><a href="/industries/healthcare-seo/">Healthcare SEO</a></li>
                        <li><a href="/industries/mental-health-seo/">Mental Health SEO</a></li>
                        <li><a href="/industries/dental-seo/">Dental SEO</a></li>
                    </ul>
                </li>
                <li><a href="/about/">About</a></li>
                <li class="nav-dropdown dropdown-right">
                    <a href="/small-business-seo-pricing/">Investment</a>
                    <ul class="nav-dropdown-menu">
                        <li><a href="/small-business-seo-pricing/"><strong>Pricing Overview</strong></a></li>
                        <li><a href="/plans/spark/">Spark &mdash; $500/mo</a></li>
                        <li><a href="/plans/blaze/">Blaze &mdash; $900/mo</a></li>
                        <li><a href="/plans/inferno/">Inferno &mdash; $1,500/mo</a></li>
                    </ul>
                </li>
                <li><a href="/order.html">Shop</a></li>
                <li><a href="/#insights">Blog</a></li>
                <li><a href="/#faq">FAQ</a></li>
                <li><a href="/#contact" class="nav-cta">Contact</a></li>
            </ul>
        </div>
    </nav>"""

FOOTER_HTML = """    <footer class="footer">
        <div class="container">
            <div class="footer-inner">
                <div class="footer-brand">
                    <p class="footer-tagline">Data-driven SEO &amp; SEM consulting.<br>Your rankings. Our fire.</p>
                </div>
                <div class="footer-links">
                    <div class="footer-col">
                        <h4>Services</h4>
                        <a href="/#services">Technical SEO</a>
                        <a href="/#services">Content Strategy</a>
                        <a href="/#services">Local SEO</a>
                        <a href="/#services">Google Ads</a>
                        <a href="/#services">Healthcare SEO</a>
                    </div>
                    <div class="footer-col">
                        <h4>Company</h4>
                        <a href="/about/">About</a>
                        <a href="/#process">Our Process</a>
                        <a href="/#pricing">Pricing</a>
                        <a href="/client-portal.html">Client Portal</a>
                        <a href="/#faq">FAQ</a>
                        <a href="/#insights">Blog</a>
                    </div>
                    <div class="footer-col">
                        <h4>Contact</h4>
                        <a href="mailto:hello@phoenixmethodseo.com">hello@phoenixmethodseo.com</a>
                        <a href="https://phoenixmethodseo.com">phoenixmethodseo.com</a>
                        <a href="/#contact">Free SEO Audit</a>
                    </div>
                </div>
            </div>
            <div class="footer-bottom">
                <p>&copy; 2026 Phoenix Method. All rights reserved.</p>
            </div>
        </div>
    </footer>"""

NAV_JS = """    <script>
    (function() {
        var toggle = document.getElementById('navToggle');
        var links = document.getElementById('navLinks');
        if (toggle && links) {
            toggle.addEventListener('click', function() { links.classList.toggle('open'); });
            links.querySelectorAll('a').forEach(function(a) {
                a.addEventListener('click', function() { links.classList.remove('open'); });
            });
        }
    })();
    </script>"""

def update_page(path):
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    original = html

    # --- Replace NAV ---
    # Match from opening <nav to closing </nav> (first occurrence)
    html = re.sub(r'<nav class="nav[^"]*"[^>]*>.*?</nav>', NAV_HTML, html, count=1, flags=re.DOTALL)

    # --- Replace FOOTER ---
    html = re.sub(r'<footer[\s\S]*?</footer>', FOOTER_HTML, html, count=1, flags=re.DOTALL)

    # --- Replace/inject nav CSS ---
    # Remove old .nav-back CSS if present
    html = re.sub(r'\s*\.nav-back\s*\{[^}]*\}', '', html)

    # Replace existing .nav { ... } block (nav section) - find the comment or the rule
    # Strategy: if NAV_CSS comment already present, remove old and inject new
    # Remove any existing nav CSS block we previously injected
    html = re.sub(r'\s*/\* ={10,} NAV ={10,} \*/.*?(?=\s*/\* =|</style>)', '', html, flags=re.DOTALL)

    # Remove existing footer CSS block
    html = re.sub(r'\s*/\* ={10,} FOOTER ={10,} \*/.*?(?=\s*/\* =|</style>)', '', html, flags=re.DOTALL)

    # Also strip old-style .footer { rules if they exist
    html = re.sub(r'\s*\.footer\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-inner\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-brand\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-tagline\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-links\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-col\s*h4\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-col\s*a\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-col\s*a:hover\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-col\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-bottom\s*\{[^}]+\}', '', html)
    html = re.sub(r'\s*\.footer-bottom\s*p\s*\{[^}]+\}', '', html)

    # Inject nav + footer CSS just before </style>
    inject = NAV_CSS + '\n' + FOOTER_CSS + '\n'
    html = html.replace('</style>', inject + '    </style>', 1)

    # --- Inject mobile nav JS before </body> ---
    # Remove existing navToggle scripts to avoid duplication
    html = re.sub(r'\s*<script>\s*\(?function\(\)\s*\{[^<]*navToggle[^<]*\}\)?\(\);\s*</script>', '', html, flags=re.DOTALL)
    html = re.sub(r'\s*<script>\s*(?:const|var|let)\s+navToggle[^<]*</script>', '', html, flags=re.DOTALL)

    if 'navToggle' not in html:
        html = html.replace('</body>', NAV_JS + '\n</body>', 1)

    if html != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        return True
    return False

updated = []
errors = []
for page in PAGES:
    full = os.path.join(ROOT, page)
    if not os.path.exists(full):
        print(f"  SKIP (not found): {page}")
        continue
    try:
        changed = update_page(full)
        status = "UPDATED" if changed else "unchanged"
        print(f"  {status}: {page}")
        if changed:
            updated.append(page)
    except Exception as e:
        print(f"  ERROR: {page} — {e}")
        errors.append(page)

print(f"\nDone. {len(updated)} updated, {len(errors)} errors.")
