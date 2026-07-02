"""Rename Site Links → Structure and improve margin/spacing in the link grid."""

CHANGES = [
    # 1. Tab button label
    (
        '<button class="tab" data-tab="links">Site Links</button>',
        '<button class="tab" data-tab="links">Structure</button>',
    ),
    # 2. Section title
    (
        '<span class="sec-title">Site Pages</span>',
        '<span class="sec-title">Site Structure</span>',
    ),
    # 3. CSS: links-group — more bottom margin, add top margin for first group breathing room
    (
        '.links-group { margin-bottom: 24px; }',
        '.links-group { margin-bottom: 32px; } .links-group:last-child { margin-bottom: 0; }',
    ),
    # 4. CSS: group title — more margin below
    (
        '.links-group-title { font-size: 12px; color: #9A95A8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; font-weight: 500; }',
        '.links-group-title { font-size: 12px; color: #9A95A8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; font-weight: 500; }',
    ),
    # 5. CSS: link grid — more gap between cards
    (
        '.links-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }',
        '.links-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }',
    ),
    # 6. CSS: link-card — more internal padding
    (
        '            background: #0E0E18; border-radius: 8px; padding: 14px;',
        '            background: #0E0E18; border-radius: 8px; padding: 16px 18px;',
    ),
]

for slug in ['lori', 'phw', 'pm', 'sunbright']:
    path = f'workers/portal/public/{slug}/index.html'
    with open(path, encoding='utf-8') as f:
        html = f.read()

    for old, new in CHANGES:
        assert old in html, f'{slug}: not found: {old[:60]}'
        html = html.replace(old, new)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)

    assert 'Structure</button>' in html
    assert 'Site Structure' in html
    print(f'{slug}: OK')

print('All 4 portals updated.')
