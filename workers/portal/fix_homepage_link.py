"""Add homepage field to each data.json and make the client name a clickable link."""
import json

HOMEPAGES = {
    'lori':      'https://lorikimmerly.com',
    'phw':       'https://www.phwcare.com',
    'pm':        'https://phoenixmethodseo.com',
    'sunbright': 'https://sunbrightrecovery.org',
}

# ── 1. Add homepage to each data.json ─────────────────────────────────────────
for slug, url in HOMEPAGES.items():
    path = f'workers/portal/public/{slug}/data.json'
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    d['homepage'] = url
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    print(f'{slug} data.json: homepage = {url}')

# ── 2. Update greeting-sub in all 4 index.html files ─────────────────────────
OLD_GREETING = "            <div class=\"greeting-sub\">Updated monthly for ${d.client}</div>"
NEW_GREETING = "            <div class=\"greeting-sub\">Updated monthly for ${d.homepage ? `<a href=\"${d.homepage}\" target=\"_blank\" rel=\"noopener\" style=\"color:inherit;text-decoration:none;border-bottom:1px solid rgba(255,255,255,0.2);padding-bottom:1px;\">${d.client}</a>` : d.client}</div>"

for slug in ['lori', 'phw', 'pm', 'sunbright']:
    path = f'workers/portal/public/{slug}/index.html'
    with open(path, encoding='utf-8') as f:
        html = f.read()
    assert OLD_GREETING in html, f'{slug}: greeting line not found'
    html = html.replace(OLD_GREETING, NEW_GREETING)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    assert 'd.homepage' in html
    print(f'{slug} index.html: OK')

print('Done.')
