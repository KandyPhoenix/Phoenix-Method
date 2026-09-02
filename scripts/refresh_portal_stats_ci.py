"""
CI portal stats refresh — the GitHub Actions counterpart of
workers/portal/update_all_portals.py.

Pulls the last full calendar month of GSC data (plus GA4 organic sessions
where a property is configured) and rewrites stats + gsc_keywords + month +
updated in each workers/portal/public/{slug}/data.json.

Differences from the local script:
- Credentials come from the GSC_CREDENTIALS environment variable (the JSON
  contents of the service-account key), not a file path on Kandy's machine.
- Paths are repo-relative, so it runs from a fresh checkout.
- No wrangler deploy / KV push here — the workflow that calls this script
  commits the files and syncs KV itself.

Run: GSC_CREDENTIALS='<service account JSON>' python scripts/refresh_portal_stats_ci.py
"""
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import requests as http_requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

REPO_ROOT = Path(__file__).resolve().parent.parent
PORTAL_PUBLIC = REPO_ROOT / "workers" / "portal" / "public"

# Per-portal config. ga4_property=None means GSC-only: GSC clicks stand in for
# the sessions metric (same convention as update_all_portals.py).
# sunbright is excluded until the site launches and has a GSC property.
PORTALS = [
    {"slug": "lori", "gsc_site": "sc-domain:lorikimmerly.com", "ga4_property": "511809869"},
    {"slug": "phw", "gsc_site": "sc-domain:phwcare.com", "ga4_property": None},
    {"slug": "pm", "gsc_site": "sc-domain:phoenixmethodseo.com", "ga4_property": None},
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


def load_service_account_info():
    raw = os.environ.get("GSC_CREDENTIALS", "").strip()
    if not raw:
        print(
            "ERROR: GSC_CREDENTIALS is not set. Provide the JSON contents of the "
            "GSC service-account key (locally: C:/Users/kandy/Work/config/gsc-credentials.json)."
        )
        sys.exit(1)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: GSC_CREDENTIALS is not valid JSON: {e}")
        sys.exit(1)


SA_INFO = load_service_account_info()


def get_creds(scopes):
    creds = service_account.Credentials.from_service_account_info(SA_INFO, scopes=scopes)
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
        r = http_requests.post(
            url,
            headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
        r.raise_for_status()
        rows = r.json().get("rows", [])
        return int(rows[0]["metricValues"][0]["value"]) if rows else 0
    except Exception as e:
        print(f"    [GA4 ERROR] {e}")
        return None


def pull_gsc(site_url):
    try:
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_info(
            SA_INFO, scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
        )
        service = build("searchconsole", "v1", credentials=creds)
        totals = (
            service.searchanalytics()
            .query(
                siteUrl=site_url,
                body={"startDate": START_DATE, "endDate": END_DATE, "type": "web", "rowLimit": 1},
            )
            .execute()
            .get("rows", [])
        )
        if totals:
            row = totals[0]
            clicks = int(row.get("clicks", 0))
            impressions = int(row.get("impressions", 0))
            ctr = round(row.get("ctr", 0) * 100, 2)
            position = round(row.get("position", 0), 1)
        else:
            clicks = impressions = 0
            ctr = position = 0.0
        queries = (
            service.searchanalytics()
            .query(
                siteUrl=site_url,
                body={
                    "startDate": START_DATE,
                    "endDate": END_DATE,
                    "type": "web",
                    "dimensions": ["query"],
                    "rowLimit": 500,
                },
            )
            .execute()
            .get("rows", [])
        )
        keyword_count = sum(1 for r in queries if int(r.get("impressions", 0)) >= 1)
        sorted_q = sorted(queries, key=lambda r: int(r.get("impressions", 0)), reverse=True)
        gsc_keywords = [
            {
                "keyword": r["keys"][0],
                "position": round(r.get("position", 0), 1),
                "clicks": int(r.get("clicks", 0)),
                "impressions": int(r.get("impressions", 0)),
            }
            for r in sorted_q[:20]
        ]
        return {
            "clicks": clicks,
            "impressions": impressions,
            "ctr": ctr,
            "position": position,
            "keywords": keyword_count,
            "gsc_keywords": gsc_keywords,
        }
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


def set_metric(stats, existing, key, new_val, is_position=False):
    change = calc_change(new_val, existing.get(key), is_position=is_position)
    stats[key] = new_val
    stats[f"{key}_change"] = change
    stats[f"{key}_trend"] = calc_trend(change)


def update_portal(portal):
    slug = portal["slug"]
    print(f"\n{'=' * 60}\n  {slug.upper()}  ({portal['gsc_site']})\n{'=' * 60}")
    data_path = PORTAL_PUBLIC / slug / "data.json"
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    existing = data.get("stats", {})

    sessions = pull_ga4_sessions(portal["ga4_property"])
    gsc = pull_gsc(portal["gsc_site"])

    if gsc is None:
        print(f"  SKIPPING {slug}: GSC pull failed")
        return False

    print(
        f"  GSC: clicks={gsc['clicks']} impr={gsc['impressions']} "
        f"ctr={gsc['ctr']}% pos={gsc['position']} kw={gsc['keywords']}"
    )
    if sessions is not None:
        print(f"  GA4 sessions: {sessions}")
    else:
        sessions = gsc["clicks"]
        print(f"  Sessions (using GSC clicks): {sessions}")

    new_stats = dict(existing)
    set_metric(new_stats, existing, "sessions", sessions)
    set_metric(new_stats, existing, "impressions", gsc["impressions"])
    set_metric(new_stats, existing, "ctr", gsc["ctr"])
    set_metric(new_stats, existing, "position", gsc["position"], is_position=True)
    set_metric(new_stats, existing, "keywords", gsc["keywords"])

    data["stats"] = new_stats
    data["gsc_keywords"] = gsc["gsc_keywords"]
    data["updated"] = TODAY_STR
    data["month"] = CURRENT_MONTH_LABEL

    # Match the repo's data.json formatting: 2-space indent, raw UTF-8, no trailing newline.
    with open(data_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"  Wrote {data_path.relative_to(REPO_ROOT)}")
    return True


def main():
    print(f"Reporting period: {START_DATE} to {END_DATE} ({MONTH_LABEL})")
    print(f"Portal 'updated' date: {TODAY_STR}")
    results = {p["slug"]: update_portal(p) for p in PORTALS}
    print(f"\n{'=' * 60}\n  SUMMARY\n{'=' * 60}")
    for slug, ok in results.items():
        print(f"  {slug}: {'refreshed' if ok else 'FAILED — left untouched'}")
    if not any(results.values()):
        print("All portal pulls failed.")
        sys.exit(1)


if __name__ == "__main__":
    main()
