import json
import subprocess
from datetime import date, timedelta
from pathlib import Path

from google.oauth2 import service_account
from google.auth.transport.requests import Request

import requests as http_requests

# --- Paths ---
CREDS_PATH = Path("C:/Users/kandy/Work/config/gsc-credentials.json")
DATA_JSON_PATH = Path("C:/Users/kandy/PHOENIX METHOD/workers/portal/public/lori/data.json")
PORTAL_DIR = Path("C:/Users/kandy/PHOENIX METHOD/workers/portal")

GA4_PROPERTY = "511809869"
GSC_SITE_URL = "sc-domain:lorikimmerly.com"

# --- Date range: previous calendar month ---
today = date.today()
first_of_this_month = today.replace(day=1)
last_month_end = first_of_this_month - timedelta(days=1)
last_month_start = last_month_end.replace(day=1)

START_DATE = last_month_start.strftime("%Y-%m-%d")
END_DATE = last_month_end.strftime("%Y-%m-%d")
MONTH_LABEL = last_month_end.strftime("%B %Y")

print(f"Reporting period: {START_DATE} to {END_DATE} ({MONTH_LABEL})")


def get_credentials(scopes):
    """Load service account credentials with the given scopes."""
    creds = service_account.Credentials.from_service_account_file(
        str(CREDS_PATH), scopes=scopes
    )
    creds.refresh(Request())
    return creds


def get_auth_header(creds):
    """Return Authorization header dict for a refreshed credential."""
    if not creds.valid:
        creds.refresh(Request())
    return {"Authorization": f"Bearer {creds.token}"}


# --- GA4 ---
def pull_ga4_sessions():
    print("\n[GA4] Pulling organic sessions...")
    try:
        scopes = ["https://www.googleapis.com/auth/analytics.readonly"]
        creds = get_credentials(scopes)
        headers = get_auth_header(creds)
        headers["Content-Type"] = "application/json"

        url = f"https://analyticsdata.googleapis.com/v1beta/properties/{GA4_PROPERTY}:runReport"
        payload = {
            "dateRanges": [{"startDate": START_DATE, "endDate": END_DATE}],
            "metrics": [
                {"name": "sessions"},
                {"name": "activeUsers"},
            ],
            "dimensionFilter": {
                "filter": {
                    "fieldName": "sessionDefaultChannelGroup",
                    "stringFilter": {
                        "matchType": "EXACT",
                        "value": "Organic Search",
                    },
                }
            },
        }

        resp = http_requests.post(url, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        rows = data.get("rows", [])
        if not rows:
            print("[GA4] No rows returned — organic sessions = 0")
            return 0

        sessions_val = int(rows[0]["metricValues"][0]["value"])
        active_users = int(rows[0]["metricValues"][1]["value"])
        print(f"[GA4] Organic sessions: {sessions_val}, Active users: {active_users}")
        return sessions_val

    except Exception as e:
        print(f"[GA4] ERROR: {e}")
        return None


# --- GSC ---
def pull_gsc_data():
    print("\n[GSC] Pulling Search Console data...")
    try:
        from googleapiclient.discovery import build

        scopes = ["https://www.googleapis.com/auth/webmasters.readonly"]
        creds = service_account.Credentials.from_service_account_file(
            str(CREDS_PATH), scopes=scopes
        )
        service = build("searchconsole", "v1", credentials=creds)

        # Overall totals (no dimensions)
        totals_resp = service.searchanalytics().query(
            siteUrl=GSC_SITE_URL,
            body={
                "startDate": START_DATE,
                "endDate": END_DATE,
                "type": "web",
                "rowLimit": 1,
            }
        ).execute()
        totals_rows = totals_resp.get("rows", [])
        if totals_rows:
            row = totals_rows[0]
            total_clicks = int(row.get("clicks", 0))
            total_impressions = int(row.get("impressions", 0))
            total_ctr = round(row.get("ctr", 0) * 100, 2)
            avg_position = round(row.get("position", 0), 1)
        else:
            print("[GSC] No totals rows returned")
            total_clicks = total_impressions = 0
            total_ctr = avg_position = 0.0

        print(f"[GSC] Clicks: {total_clicks}, Impressions: {total_impressions}, CTR: {total_ctr}%, Position: {avg_position}")

        # Top queries
        queries_resp = service.searchanalytics().query(
            siteUrl=GSC_SITE_URL,
            body={
                "startDate": START_DATE,
                "endDate": END_DATE,
                "type": "web",
                "dimensions": ["query"],
                "rowLimit": 500,
            }
        ).execute()
        all_rows = queries_resp.get("rows", [])

        keyword_count = sum(1 for r in all_rows if int(r.get("impressions", 0)) >= 1)
        print(f"[GSC] Queries with impressions: {keyword_count}")

        sorted_rows = sorted(all_rows, key=lambda r: int(r.get("impressions", 0)), reverse=True)
        gsc_keywords = [
            {
                "keyword": r["keys"][0],
                "position": round(r.get("position", 0), 1),
                "clicks": int(r.get("clicks", 0)),
                "impressions": int(r.get("impressions", 0)),
            }
            for r in sorted_rows[:20]
        ]

        return {
            "clicks": total_clicks,
            "impressions": total_impressions,
            "ctr": total_ctr,
            "position": avg_position,
            "keywords": keyword_count,
            "gsc_keywords": gsc_keywords,
        }

    except Exception as e:
        print(f"[GSC] ERROR: {e}")
        return None


# --- Change calculation ---
def calc_change(new_val, old_val, is_position=False):
    """Return a change string like '+12', '-5', or 'Baseline'."""
    if old_val is None or str(old_val) == "Baseline":
        return "Baseline"
    try:
        old = float(old_val) if isinstance(old_val, str) else old_val
        new = float(new_val)
        delta = new - old
        if is_position:
            # Lower position = better, so invert sign for display
            delta_display = round(-delta, 1)
        else:
            delta_display = round(delta, 1)
        if delta_display == int(delta_display):
            delta_display = int(delta_display)
        if delta_display > 0:
            return f"+{delta_display}"
        else:
            return str(delta_display)
    except Exception:
        return "Baseline"


def calc_trend(change_str, is_position=False):
    """Return 'up', 'down', or 'neutral' based on change string."""
    if change_str == "Baseline" or change_str is None:
        return "neutral"
    try:
        val = float(change_str.replace("+", ""))
        if val > 0:
            return "up"
        elif val < 0:
            return "down"
        else:
            return "neutral"
    except Exception:
        return "neutral"


# --- Main ---
def main():
    # Load existing data.json
    with open(DATA_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    existing_stats = data.get("stats", {})

    # Pull fresh data
    ga4_sessions = pull_ga4_sessions()
    gsc = pull_gsc_data()

    # --- Build updated stats ---
    stats = dict(existing_stats)  # start from existing, overwrite only what we fetched

    if ga4_sessions is not None:
        old_sessions = existing_stats.get("sessions")
        sessions_change = calc_change(ga4_sessions, old_sessions)
        stats["sessions"] = ga4_sessions
        stats["sessions_change"] = sessions_change
        stats["sessions_trend"] = calc_trend(sessions_change)

    if gsc is not None:
        old_impressions = existing_stats.get("impressions")
        impressions_change = calc_change(gsc["impressions"], old_impressions)
        stats["impressions"] = gsc["impressions"]
        stats["impressions_change"] = impressions_change
        stats["impressions_trend"] = calc_trend(impressions_change)

        old_ctr = existing_stats.get("ctr")
        ctr_change = calc_change(gsc["ctr"], old_ctr)
        stats["ctr"] = gsc["ctr"]
        stats["ctr_change"] = ctr_change
        stats["ctr_trend"] = calc_trend(ctr_change)

        old_position = existing_stats.get("position")
        position_change = calc_change(gsc["position"], old_position, is_position=True)
        stats["position"] = gsc["position"]
        stats["position_change"] = position_change
        # For position: improvement = position number goes DOWN = trend "up" for client
        stats["position_trend"] = calc_trend(position_change)

        old_keywords = existing_stats.get("keywords")
        keywords_change = calc_change(gsc["keywords"], old_keywords)
        stats["keywords"] = gsc["keywords"]
        stats["keywords_change"] = keywords_change
        stats["keywords_trend"] = calc_trend(keywords_change)

        data["gsc_keywords"] = gsc["gsc_keywords"]

    # Update top-level fields
    data["stats"] = stats
    data["updated"] = today.strftime("%Y-%m-%d")
    data["month"] = today.strftime("%B %Y")  # current month, not reporting period

    # Write data.json
    with open(DATA_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n[DATA] data.json updated at {DATA_JSON_PATH}")

    # --- Deploy ---
    print("\n[DEPLOY] Running wrangler deploy...")
    result = subprocess.run(
        ["wrangler", "deploy"],
        cwd=str(PORTAL_DIR),
        shell=True,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print("[DEPLOY] Success!")
        print(result.stdout)
    else:
        print("[DEPLOY] ERROR!")
        print(result.stdout)
        print(result.stderr)

    # --- Summary ---
    print("\n" + "=" * 50)
    print("PORTAL UPDATE SUMMARY")
    print("=" * 50)
    print(f"Month reported:  {MONTH_LABEL}")
    print(f"Updated:         {data['updated']}")
    print(f"Sessions:        {stats.get('sessions')}  (change: {stats.get('sessions_change', 'n/a')})")
    print(f"Impressions:     {stats.get('impressions')}  (change: {stats.get('impressions_change', 'n/a')})")
    print(f"CTR:             {stats.get('ctr')}%  (change: {stats.get('ctr_change', 'n/a')})")
    print(f"Avg Position:    {stats.get('position')}  (change: {stats.get('position_change', 'n/a')})")
    print(f"Keywords:        {stats.get('keywords')}  (change: {stats.get('keywords_change', 'n/a')})")
    print(f"Top keywords:    {len(data.get('gsc_keywords', []))} rows")
    print("=" * 50)


if __name__ == "__main__":
    main()
