"""
Unified portal stats updater — refreshes Lori, PHW, and PM portals with last calendar month's
GSC data (and GA4 sessions where a property is configured).

Run from anywhere:
  py "C:\\Users\\kandy\\PHOENIX METHOD\\workers\\portal\\update_all_portals.py"

What it does:
- Pulls last full calendar month from GSC for each site
- Pulls GA4 organic sessions where GA4_PROPERTY is set (Lori only as of 2026-05-10)
- Computes change/trend vs current portal stats (treats "Baseline" as no prior comparison)
- Updates each public/{slug}/data.json: stats + gsc_keywords + updated date + month label
- Deploys via wrangler deploy
- Pushes each updated data.json to KV (PORTAL_DATA) — REQUIRED, deploy alone doesn't update live data
"""
import json, subprocess, sys
from datetime import date, timedelta
from pathlib import Path
from google.oauth2 import service_account
from google.auth.transport.requests import Request
import requests as http_requests

CREDS_PATH = Path("C:/Users/kandy/Work/config/gsc-credentials.json")
PORTAL_DIR = Path("C:/Users/kandy/GitHub/Phoenix Method/workers/portal")

# Per-portal config. GA4_PROPERTY=None means GSC-only (no organic-sessions metric pull).
PORTALS = [
    {
        "slug": "lori",
        "gsc_site": "sc-domain:lorikimmerly.com",
        "ga4_property": "511809869",
    },
    {
        "slug": "phw",
        "gsc_site": "sc-domain:phwcare.com",
        "ga4_property": None,  # Squarespace, no GA4 service-account access
    },
    {
        "slug": "pm",
        "gsc_site": "sc-domain:phoenixmethodseo.com",
        "ga4_property": None,
    },
]

# --- Date range: previous calendar month ---
today = date.today()
first_of_this_month = today.replace(day=1)
last_month_end = first_of_this_month - timedelta(days=1)
last_month_start = last_month_end.replace(day=1)
START_DATE = last_month_start.strftime("%Y-%m-%d")
END_DATE = last_month_end.strftime("%Y-%m-%d")
MONTH_LABEL = last_month_end.strftime("%B %Y")
TODAY_STR = today.strftime("%Y-%m-%d")
CURRENT_MONTH_LABEL = today.strftime("%B %Y")


def get_creds(scopes):
    creds = service_account.Credentials.from_service_account_file(str(CREDS_PATH), scopes=scopes)
    creds.refresh(Request())
    return creds


def pull_ga4_sessions(property_id):
    if not property_id:
        return None
    try:
        creds = get_creds(["https://www.googleapis.com/auth/analytics.readonly"])
        url = f"https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"
        payload = {
            "dateRanges": [{"startDate": START_DATE, "endDate": END_DATE}],
            "metrics": [{"name": "sessions"}],
            "dimensionFilter": {
                "filter": {
                    "fieldName": "sessionDefaultChannelGroup",
                    "stringFilter": {"matchType": "EXACT", "value": "Organic Search"},
                }
            },
        }
        r = http_requests.post(url, headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"}, json=payload, timeout=30)
        r.raise_for_status()
        rows = r.json().get("rows", [])
        return int(rows[0]["metricValues"][0]["value"]) if rows else 0
    except Exception as e:
        print(f"    [GA4 ERROR] {e}")
        return None


def pull_gsc(site_url):
    try:
        from googleapiclient.discovery import build
        creds = service_account.Credentials.from_service_account_file(
            str(CREDS_PATH), scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
        )
        service = build("searchconsole", "v1", credentials=creds)
        # Totals
        totals = service.searchanalytics().query(
            siteUrl=site_url,
            body={"startDate": START_DATE, "endDate": END_DATE, "type": "web", "rowLimit": 1},
        ).execute().get("rows", [])
        if totals:
            row = totals[0]
            clicks = int(row.get("clicks", 0))
            impressions = int(row.get("impressions", 0))
            ctr = round(row.get("ctr", 0) * 100, 2)
            position = round(row.get("position", 0), 1)
        else:
            clicks = impressions = 0
            ctr = position = 0.0
        # Top queries
        queries = service.searchanalytics().query(
            siteUrl=site_url,
            body={"startDate": START_DATE, "endDate": END_DATE, "type": "web", "dimensions": ["query"], "rowLimit": 500},
        ).execute().get("rows", [])
        keyword_count = sum(1 for r in queries if int(r.get("impressions", 0)) >= 1)
        sorted_q = sorted(queries, key=lambda r: int(r.get("impressions", 0)), reverse=True)
        gsc_keywords = [
            {"keyword": r["keys"][0], "position": round(r.get("position", 0), 1), "clicks": int(r.get("clicks", 0)), "impressions": int(r.get("impressions", 0))}
            for r in sorted_q[:20]
        ]
        return {"clicks": clicks, "impressions": impressions, "ctr": ctr, "position": position, "keywords": keyword_count, "gsc_keywords": gsc_keywords}
    except Exception as e:
        print(f"    [GSC ERROR] {e}")
        return None


def calc_change(new_val, old_val, is_position=False):
    if old_val is None or str(old_val) == "Baseline":
        return "Baseline"
    try:
        old = float(old_val) if isinstance(old_val, str) else old_val
        new = float(new_val)
        delta = new - old
        if is_position:
            delta = -delta  # lower position = better
        delta_disp = round(delta, 1)
        if delta_disp == int(delta_disp):
            delta_disp = int(delta_disp)
        return f"+{delta_disp}" if delta_disp > 0 else str(delta_disp)
    except Exception:
        return "Baseline"


def calc_trend(change_str):
    if change_str in (None, "Baseline"):
        return "neutral"
    try:
        v = float(str(change_str).replace("+", ""))
        return "up" if v > 0 else "down" if v < 0 else "neutral"
    except Exception:
        return "neutral"


def update_portal(portal):
    slug = portal["slug"]
    print(f"\n{'='*60}\n  {slug.upper()}  ({portal['gsc_site']})\n{'='*60}")
    data_path = PORTAL_DIR / "public" / slug / "data.json"
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    existing = data.get("stats", {})

    sessions = pull_ga4_sessions(portal["ga4_property"])
    gsc = pull_gsc(portal["gsc_site"])

    if gsc is None:
        print(f"  SKIPPING {slug}: GSC pull failed")
        return None

    print(f"  GSC: clicks={gsc['clicks']} impr={gsc['impressions']} ctr={gsc['ctr']}% pos={gsc['position']} kw={gsc['keywords']}")
    if sessions is not None:
        print(f"  GA4 sessions: {sessions}")
    else:
        # Fall back to GSC clicks as the "sessions" metric for GA4-less sites
        sessions = gsc["clicks"]
        print(f"  Sessions (using GSC clicks): {sessions}")

    new_stats = dict(existing)
    # sessions
    sc = calc_change(sessions, existing.get("sessions"))
    new_stats["sessions"] = sessions
    new_stats["sessions_change"] = sc
    new_stats["sessions_trend"] = calc_trend(sc)
    # impressions
    ic = calc_change(gsc["impressions"], existing.get("impressions"))
    new_stats["impressions"] = gsc["impressions"]
    new_stats["impressions_change"] = ic
    new_stats["impressions_trend"] = calc_trend(ic)
    # ctr
    cc = calc_change(gsc["ctr"], existing.get("ctr"))
    new_stats["ctr"] = gsc["ctr"]
    new_stats["ctr_change"] = cc
    new_stats["ctr_trend"] = calc_trend(cc)
    # position
    pc = calc_change(gsc["position"], existing.get("position"), is_position=True)
    new_stats["position"] = gsc["position"]
    new_stats["position_change"] = pc
    new_stats["position_trend"] = calc_trend(pc)
    # keywords
    kc = calc_change(gsc["keywords"], existing.get("keywords"))
    new_stats["keywords"] = gsc["keywords"]
    new_stats["keywords_change"] = kc
    new_stats["keywords_trend"] = calc_trend(kc)

    data["stats"] = new_stats
    data["gsc_keywords"] = gsc["gsc_keywords"]
    data["updated"] = TODAY_STR
    data["month"] = CURRENT_MONTH_LABEL

    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Wrote {data_path}")
    return data


def deploy():
    print(f"\n{'='*60}\n  DEPLOY (wrangler deploy)\n{'='*60}")
    r = subprocess.run(["wrangler", "deploy"], cwd=str(PORTAL_DIR), shell=True, capture_output=True, text=True)
    print(r.stdout[-500:] if r.stdout else "")
    if r.returncode != 0:
        print("DEPLOY FAILED")
        print(r.stderr[-500:])
        sys.exit(1)


def kv_push(slug):
    print(f"  KV push: {slug}")
    data_file = f"public/{slug}/data.json"
    r = subprocess.run(
        ["wrangler", "kv", "key", "put", "--binding=PORTAL_DATA", slug, "--path", data_file, "--remote"],
        cwd=str(PORTAL_DIR), shell=True, capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"    KV push FAILED for {slug}: {r.stderr[-300:]}")
    else:
        print(f"    KV push ok for {slug}")


def main():
    print(f"Reporting period: {START_DATE} to {END_DATE} ({MONTH_LABEL})")
    print(f"Portal 'updated' date: {TODAY_STR}")

    updated_slugs = []
    for portal in PORTALS:
        result = update_portal(portal)
        if result:
            updated_slugs.append(portal["slug"])

    if not updated_slugs:
        print("\nNo portals were updated successfully.")
        return

    deploy()

    print(f"\n{'='*60}\n  KV PUSH\n{'='*60}")
    for slug in updated_slugs:
        kv_push(slug)

    print(f"\n{'='*60}\n  SUMMARY\n{'='*60}")
    for slug in updated_slugs:
        print(f"  {slug}: https://portal.phoenixmethod.workers.dev/{slug}/  -> updated {TODAY_STR}")


if __name__ == "__main__":
    main()
