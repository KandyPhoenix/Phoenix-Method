"""
wire_site_chrome.py
Replaces inline nav + footer HTML with shared JS/CSS placeholders on all pages.
Run once — after this, edit /assets/site-chrome.js and /assets/site-chrome.css to update all pages.
"""

import re
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAGES = [
    "index.html",
    "about/index.html",
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
    "ai-overviews-seo-optimization-guide.html",
    "blog-march-2026-core-update.html",
    "google-core-update-march-2026-seo-guide.html",
]

CSS_LINK = '<link rel="stylesheet" href="/assets/site-chrome.css">'
JS_SCRIPT = '<script src="/assets/site-chrome.js" defer></script>'

# Mobile nav toggle JS block injected by update_nav_footer.py — remove it since site-chrome.js handles it
MOBILE_JS_PATTERN = re.compile(
    r'\s*// Mobile nav toggle\s*\n'
    r'\s*(?:const|var|let) navToggle\s*=.*?\n'
    r'\s*(?:const|var|let) navLinks\s*=.*?\n'
    r'(?:.*?navToggle\.addEventListener.*?}\);\s*\n)?'
    r'(?:.*?navLinks\.querySelectorAll.*?}\);\s*\n)?',
    re.DOTALL
)

# Broader pattern to catch the full injected mobile nav block
MOBILE_JS_BLOCK = re.compile(
    r'[ \t]*// Mobile nav toggle\n'
    r'[ \t]*(?:const|var) navToggle = document\.getElementById\([\'"]navToggle[\'"]\);?\n'
    r'[ \t]*(?:const|var) navLinks = document\.getElementById\([\'"]navLinks[\'"]\);?\n'
    r'[ \t]*(?:if \(navToggle\) \{[^}]*\}|navToggle\.addEventListener\(\'click\', \(\) => \{[^}]*\}\);)\n'
    r'[ \t]*(?:if \(navLinks\) \{[^}]*\}|navLinks\.querySelectorAll\(\'a\'\)\.forEach\(link => \{[^}]*\}\);)?\n?',
    re.DOTALL
)

results = []

for rel_path in PAGES:
    path = os.path.join(BASE, rel_path.replace("/", os.sep))
    if not os.path.exists(path):
        results.append(f"  SKIP (not found): {rel_path}")
        continue

    with open(path, "r", encoding="utf-8") as f:
        html = f.read()

    original = html
    changed = []

    # 1. Replace <nav class="nav..."...>...</nav> with placeholder (any variant incl. "nav scrolled")
    nav_pattern = re.compile(r'<nav class="nav[^"]*"[^>]*>.*?</nav>', re.DOTALL)
    if '<div id="pm-nav">' in html or '<div id="pm-nav"></div>' in html:
        pass  # already converted
    elif nav_pattern.search(html):
        html = nav_pattern.sub('<div id="pm-nav"></div>', html)
        changed.append("nav->placeholder")
    else:
        changed.append("nav: NOT FOUND")

    # 2. Replace <footer...>...</footer> with placeholder (any variant)
    footer_pattern = re.compile(r'<footer[^>]*>.*?</footer>', re.DOTALL)
    if '<div id="pm-footer">' in html or '<div id="pm-footer"></div>' in html:
        pass  # already converted
    elif footer_pattern.search(html):
        html = footer_pattern.sub('<div id="pm-footer"></div>', html)
        changed.append("footer->placeholder")
    else:
        changed.append("footer: NOT FOUND")

    # 3. Add site-chrome.css link to <head> if not already present
    if CSS_LINK not in html:
        # Insert before </head>
        html = html.replace("</head>", CSS_LINK + "\n</head>", 1)
        changed.append("css link added")

    # 4. Add site-chrome.js before </body> if not already present
    if JS_SCRIPT not in html:
        html = html.replace("</body>", JS_SCRIPT + "\n</body>", 1)
        changed.append("js script added")

    # 5. Remove duplicate inline mobile nav toggle JS (injected by update_nav_footer.py)
    # Pattern: the standalone <script> block that only has nav toggle
    standalone_nav_script = re.compile(
        r'\s*<script>\s*\n\s*// Mobile nav toggle\n.*?</script>',
        re.DOTALL
    )
    if standalone_nav_script.search(html):
        html = standalone_nav_script.sub('', html)
        changed.append("removed standalone nav-toggle script")

    if html != original:
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        results.append(f"  OK: {rel_path} — {', '.join(changed)}")
    else:
        results.append(f"  UNCHANGED: {rel_path}")

import sys
sys.stdout.reconfigure(encoding='utf-8')
print("wire_site_chrome.py - results:")
for r in results:
    print(r)
print("\nDone.")
