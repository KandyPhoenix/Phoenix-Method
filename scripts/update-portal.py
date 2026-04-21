"""
Monthly portal update script.
Usage: py scripts/update-portal.py phw [--push]

Pulls GSC data, updates portal/[client]/data.json, optionally commits + pushes.
"""
import sys, json, subprocess
from datetime import date, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(__file__).parent.parent
CREDS_FILE = Path('C:/Users/kandy/Work/config/gsc-credentials.json')

CLIENT_MAP = {
    'phw': {
        'name': 'Parish Health and Wellness',
        'short_name': 'PHW',
        'plan': 'Blaze',
        'plan_price': '$900/mo',
        'plan_hours': 10,
        'sc_property': 'sc-domain:phwcare.com',
        'data_path': 'portal/phw/data.json',
    },
    'lori': {
        'name': 'Lori Kimmerly',
        'short_name': 'LOR',
        'plan': 'Blaze',
        'plan_price': '$900/mo',
        'plan_hours': 10,
        'sc_property': 'sc-domain:lorikimmerly.com',
        'data_path': 'portal/lori/data.json',
    },
}

def pull_gsc(sc_property):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        str(CREDS_FILE), scopes=['https://www.googleapis.com/auth/webmasters.readonly']
    )
    gsc = build('searchconsole', 'v1', credentials=creds)

    today = date.today()
    start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')

    # Overall
    overall = gsc.searchanalytics().query(
        siteUrl=sc_property,
        body={'startDate': start, 'endDate': end, 'dimensions': [], 'rowLimit': 1}
    ).execute()
    totals = overall.get('rows', [{}])[0] if overall.get('rows') else {}

    # Keywords
    kw_resp = gsc.searchanalytics().query(
        siteUrl=sc_property,
        body={
            'startDate': start, 'endDate': end,
            'dimensions': ['query'], 'rowLimit': 50,
            'orderBy': [{'fieldName': 'impressions', 'sortOrder': 'DESCENDING'}]
        }
    ).execute()

    # Filter junk queries (operator-heavy, phone numbers, addresses)
    raw_keywords = kw_resp.get('rows', [])
    clean_keywords = []
    skip_patterns = ['site:', '-site:', 'inurl:', 'filetype:', 'intitle:', '-"', '+site']
    for kw in raw_keywords:
        q = kw['keys'][0]
        if any(p in q for p in skip_patterns): continue
        if len(q) < 3: continue
        if q.replace(' ', '').replace('-', '').isdigit(): continue
        clean_keywords.append(kw)

    # Top keyword = highest clicks; fallback to best position
    top_kw = max(clean_keywords, key=lambda k: k['clicks']) if clean_keywords else None

    return {
        'clicks': int(totals.get('clicks', 0)),
        'impressions': int(totals.get('impressions', 0)),
        'ctr': round(totals.get('ctr', 0) * 100, 2),
        'position': round(totals.get('position', 0), 1),
        'keywords': clean_keywords,
        'top_keyword': top_kw['keys'][0] if top_kw else '—',
        'top_keyword_position': round(top_kw['position'], 0) if top_kw else None,
    }

def update_client(client_key, push=False):
    if client_key not in CLIENT_MAP:
        print(f'Unknown client: {client_key}. Options: {list(CLIENT_MAP.keys())}')
        sys.exit(1)

    cfg = CLIENT_MAP[client_key]
    data_path = REPO_ROOT / cfg['data_path']

    print(f'Pulling GSC data for {cfg["name"]}...')
    gsc = pull_gsc(cfg['sc_property'])

    today = date.today()
    month_label = today.strftime('%B %Y')

    # Load existing data to preserve deliverables, calendar, message, billing
    existing = {}
    if data_path.exists():
        with open(data_path) as f:
            existing = json.load(f)

    # Build updated keyword list — carry over last_month from existing
    existing_kw_map = {kw['keyword']: kw for kw in existing.get('keywords', [])}
    new_keywords = []
    for kw in gsc['keywords']:
        q = kw['keys'][0]
        pos = round(kw['position'], 1)
        last = existing_kw_map.get(q, {}).get('position')
        new_keywords.append({'keyword': q, 'position': pos, 'last_month': last})

    # Carry forward keywords that dropped out of GSC this month (keep last 60 days)
    for kw in existing.get('keywords', []):
        if not any(k['keyword'] == kw['keyword'] for k in new_keywords):
            new_keywords.append({
                'keyword': kw['keyword'],
                'position': kw['position'],
                'last_month': kw.get('last_month'),
            })

    # Calculate stat changes
    prev_sessions = existing.get('stats', {}).get('sessions')
    prev_position = existing.get('stats', {}).get('position')
    prev_keywords = existing.get('stats', {}).get('keywords')

    def pct_change(current, prev):
        if prev is None or prev == 0: return 'Baseline'
        pct = round(((current - prev) / prev) * 100, 1)
        return f'+{pct}%' if pct >= 0 else f'{pct}%'

    def pos_change(current, prev):
        if prev is None: return 'Baseline'
        diff = round(prev - current, 1)  # lower = better
        if diff > 0: return f'+{diff} pts'
        if diff < 0: return f'{diff} pts'
        return 'No change'

    def kw_change(current, prev):
        if prev is None: return 'Baseline'
        diff = current - prev
        if diff > 0: return f'+{diff} new'
        if diff < 0: return f'{diff}'
        return 'No change'

    sessions_trend = 'neutral' if prev_sessions is None else ('up' if gsc['clicks'] >= prev_sessions else 'down')
    pos_trend = 'neutral' if prev_position is None else ('up' if gsc['position'] <= prev_position else 'down')
    kw_trend = 'neutral' if prev_keywords is None else ('up' if len(gsc['keywords']) >= prev_keywords else 'down')

    # Build updated data
    data = {
        'client': cfg['name'],
        'short_name': cfg['short_name'],
        'month': month_label,
        'plan': existing.get('plan', cfg['plan']),
        'plan_price': existing.get('plan_price', cfg['plan_price']),
        'plan_hours': existing.get('plan_hours', cfg['plan_hours']),
        'hours_used': existing.get('hours_used', 0),
        'updated': today.strftime('%Y-%m-%d'),
        'stats': {
            'sessions': gsc['clicks'],
            'sessions_change': pct_change(gsc['clicks'], prev_sessions),
            'sessions_trend': sessions_trend,
            'keywords': len(gsc['keywords']),
            'keywords_change': kw_change(len(gsc['keywords']), prev_keywords),
            'keywords_trend': kw_trend,
            'position': gsc['position'],
            'position_change': pos_change(gsc['position'], prev_position),
            'position_trend': pos_trend,
            'impressions': gsc['impressions'],
            'impressions_change': pct_change(gsc['impressions'], existing.get('stats', {}).get('impressions')),
            'impressions_trend': 'neutral' if existing.get('stats', {}).get('impressions') is None else ('up' if gsc['impressions'] >= existing['stats']['impressions'] else 'down'),
        },
        'deliverables': existing.get('deliverables', []),
        'keywords': new_keywords,
        'content_calendar': existing.get('content_calendar', []),
        'message': existing.get('message', {
            'from': 'Kandy',
            'date': today.strftime('%B %d, %Y'),
            'text': f'Portal updated for {month_label}.',
        }),
    }

    with open(data_path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f'Updated {data_path}')
    print(f'  Sessions: {gsc["clicks"]} | Position: {gsc["position"]} | Keywords: {len(gsc["keywords"])}')

    if push:
        subprocess.run(['git', '-C', str(REPO_ROOT), 'add', cfg['data_path']], check=True)
        msg = f'PM-67: Update {cfg["short_name"]} portal data — {month_label}'
        subprocess.run(['git', '-C', str(REPO_ROOT), 'commit', '-m', msg], check=True)
        subprocess.run(['git', '-C', str(REPO_ROOT), 'push'], check=True)
        print('Pushed to GitHub.')

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print('Usage: py scripts/update-portal.py [client] [--push]')
        print('Example: py scripts/update-portal.py phw --push')
        sys.exit(0)

    client_key = args[0].lower()
    push = '--push' in args
    update_client(client_key, push=push)
