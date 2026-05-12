"""
Monthly portal reset script.
Usage: python tools/portal-monthly-reset.py <slug>
  slug: lori | phw | pm

Runs on the 1st of each month via GitHub Actions (monthly-reset.yml).
Pulls GSC data, resets hours/deliverables, updates stats, commits.
"""

import sys
import json
import os
from datetime import date, timedelta
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

REPO_ROOT = Path(__file__).parent.parent
PORTAL_DIR = REPO_ROOT / "workers/portal/public"

SITE_CONFIG = {
    "lori": {
        "gsc_property": os.environ.get("LORI_GSC_PROPERTY", "sc-domain:lorikimmerly.com"),
    },
    "phw": {
        "gsc_property": os.environ.get("PHW_GSC_PROPERTY", "sc-domain:phwcare.com"),
    },
}


def get_gsc_service():
    creds_path = os.environ.get("GSC_CREDS_PATH", "/tmp/gsc-credentials.json")
    creds = service_account.Credentials.from_service_account_file(
        creds_path,
        scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
    )
    return build("searchconsole", "v1", credentials=creds)


def pull_gsc_stats(service, gsc_property):
    """
    Returns stats for current 28-day window and previous 28-day window.
    Uses a 3-day lag to account for GSC data freshness.
    """
    today = date.today()
    end = today - timedelta(days=3)
    start = end - timedelta(days=27)
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=27)

    def query(start_d, end_d, dimensions=None, row_limit=20):
        body = {
            "startDate": start_d.strftime("%Y-%m-%d"),
            "endDate": end_d.strftime("%Y-%m-%d"),
            "rowLimit": row_limit,
        }
        if dimensions:
            body["dimensions"] = dimensions
        return service.searchanalytics().query(
            siteUrl=gsc_property, body=body
        ).execute()

    # Totals (no dimensions = single aggregated row from GSC)
    cur_agg = query(start, end).get("rows", [{}])[0]
    cur_clicks = int(cur_agg.get("clicks", 0))
    cur_impr = int(cur_agg.get("impressions", 0))
    cur_pos = round(cur_agg.get("position", 0.0), 1)
    cur_ctr = round(cur_clicks / cur_impr * 100, 2) if cur_impr else 0.0

    prev_agg = query(prev_start, prev_end).get("rows", [{}])[0]
    prev_clicks = int(prev_agg.get("clicks", 0))
    prev_impr = int(prev_agg.get("impressions", 0))
    prev_pos = round(prev_agg.get("position", 0.0), 1)
    prev_ctr = round(prev_clicks / prev_impr * 100, 2) if prev_impr else 0.0

    # Keyword count — query with dimensions to count unique ranking queries
    cur_kw_rows = query(start, end, dimensions=["query"], row_limit=500).get("rows", [])
    prev_kw_rows = query(prev_start, prev_end, dimensions=["query"], row_limit=500).get("rows", [])
    cur_kw_count = len(cur_kw_rows)
    prev_kw_count = len(prev_kw_rows)

    def change(cur_val, prev_val, is_pos=False):
        diff = round(cur_val - prev_val, 1) if isinstance(cur_val, float) else cur_val - prev_val
        if diff == 0:
            return "0", "neutral"
        if is_pos:
            # Lower position = better
            return (f"+{diff}" if diff > 0 else str(diff)), ("down" if diff > 0 else "up")
        return (f"+{diff}" if diff > 0 else str(diff)), ("up" if diff > 0 else "down")

    clicks_chg, clicks_trend = change(cur_clicks, prev_clicks)
    impr_chg, impr_trend = change(cur_impr, prev_impr)
    pos_chg, pos_trend = change(cur_pos, prev_pos, is_pos=True)
    ctr_chg, ctr_trend = change(cur_ctr, prev_ctr)

    stats = {
        "sessions": cur_clicks,
        "sessions_change": clicks_chg,
        "sessions_trend": clicks_trend,
        "keywords": cur_kw_count,
        "keywords_change": change(cur_kw_count, prev_kw_count)[0],
        "keywords_trend": change(cur_kw_count, prev_kw_count)[1],
        "position": cur_pos,
        "position_change": pos_chg,
        "position_trend": pos_trend,
        "impressions": cur_impr,
        "impressions_change": impr_chg,
        "impressions_trend": impr_trend,
        "ctr": cur_ctr,
        "ctr_change": ctr_chg,
        "ctr_trend": ctr_trend,
    }

    # Top 20 keywords by impressions
    kw_resp = service.searchanalytics().query(
        siteUrl=gsc_property,
        body={
            "startDate": start.strftime("%Y-%m-%d"),
            "endDate": end.strftime("%Y-%m-%d"),
            "dimensions": ["query"],
            "rowLimit": 20,
            "orderBy": [{"fieldName": "impressions", "sortOrder": "DESCENDING"}],
        }
    ).execute()
    gsc_keywords = [
        {
            "keyword": row["keys"][0],
            "position": round(row.get("position", 0), 1),
            "clicks": int(row.get("clicks", 0)),
            "impressions": int(row.get("impressions", 0)),
        }
        for row in kw_resp.get("rows", [])
    ]

    return stats, gsc_keywords


def update_keyword_positions(service, gsc_property, tracked_keywords):
    """Refresh position data for the tracked keywords list."""
    today = date.today()
    end = today - timedelta(days=3)
    start = end - timedelta(days=27)

    resp = service.searchanalytics().query(
        siteUrl=gsc_property,
        body={
            "startDate": start.strftime("%Y-%m-%d"),
            "endDate": end.strftime("%Y-%m-%d"),
            "dimensions": ["query"],
            "rowLimit": 500,
        }
    ).execute()

    live_data = {
        row["keys"][0]: {
            "position": round(row.get("position", 0), 1),
            "clicks": int(row.get("clicks", 0)),
        }
        for row in resp.get("rows", [])
    }

    updated = []
    for kw_entry in tracked_keywords:
        kw = kw_entry["keyword"]
        live = live_data.get(kw)
        new_entry = dict(kw_entry)
        new_entry["last_month"] = kw_entry.get("position")  # shift current → last_month
        if live:
            new_entry["position"] = live["position"]
            new_entry["clicks"] = live["clicks"]
        else:
            new_entry["position"] = None
            new_entry["clicks"] = 0
        updated.append(new_entry)

    return updated


def month_name(d):
    return d.strftime("%B %Y")


def next_month_first(d):
    if d.month == 12:
        return date(d.year + 1, 1, 1)
    return date(d.year, d.month + 1, 1)


def quarter_end(d):
    quarter_ends = {1: 3, 2: 3, 3: 3, 4: 6, 5: 6, 6: 6, 7: 9, 8: 9, 9: 9, 10: 12, 11: 12, 12: 12}
    end_month = quarter_ends[d.month]
    end_year = d.year
    if end_month < d.month:
        end_year += 1
    last_day = (date(end_year, end_month % 12 + 1, 1) - timedelta(days=1)).day
    return date(end_year, end_month, last_day)


def reset_deliverables(deliverables, today):
    reset = []
    for item in deliverables:
        new = dict(item)
        if new.get("status") == "done":
            new["status"] = "todo"
        # Update quarterly report due date
        if "Quarterly" in new.get("text", ""):
            q_end = quarter_end(today)
            new["due"] = q_end.strftime("%b %-d") if sys.platform != "win32" else q_end.strftime("%b %d").lstrip("0")
        reset.append(new)
    return reset


def build_content_calendar(today):
    m = today.strftime("%b")
    next_m_first = next_month_first(today)
    last_day_this_month = (next_m_first - timedelta(days=1))
    q_end = quarter_end(today)

    cal = [
        {"date": f"{m} 15", "title": "Blog Topic or Draft Submission Due", "type": "client"},
        {"date": f"{m} {last_day_this_month.day}", "title": "Blog Post or SEO Op", "type": "deliverable"},
    ]
    if q_end.month == today.month:
        cal.append({
            "date": f"{q_end.strftime('%b')} {q_end.day}",
            "title": "Quarterly Performance Report",
            "type": "deliverable"
        })
    return cal


def reset_content_choice(data):
    cc = data.get("content_choice", {})
    return {
        "chosen": None,
        "blog": {"title": None, "keyword": None, "status": "pending"},
        "page": cc.get("page", {"title": None, "url": None, "keyword": None, "status": "suggested"}),
    }


def reset(slug):
    cfg = SITE_CONFIG.get(slug)
    if not cfg:
        print(f"Unknown slug: {slug}")
        sys.exit(1)

    portal_path = PORTAL_DIR / slug / "data.json"
    with open(portal_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    today = date.today()

    print(f"Pulling GSC data for {cfg['gsc_property']}...")
    service = get_gsc_service()
    new_stats, gsc_keywords = pull_gsc_stats(service, cfg["gsc_property"])
    updated_keywords = update_keyword_positions(service, cfg["gsc_property"], data.get("keywords", []))

    # Handle hour rollover before resetting
    plan_hours = data.get("plan_hours", 1)
    hours_used = data.get("hours_used", 0)
    hours_rolled_over = data.get("hours_rolled_over", 0)
    if data.get("rollover_enabled") and hours_used < plan_hours:
        hours_rolled_over += (plan_hours - hours_used)
        print(f"Rolling over {plan_hours - hours_used} unused hour(s). Total banked: {hours_rolled_over}")

    # Next invoice = 1st of next month after today
    invoice_date = next_month_first(today)
    invoice_label = invoice_date.strftime("%B %-d, %Y") if sys.platform != "win32" else invoice_date.strftime("%B %d, %Y").replace(" 0", " ")

    data.update({
        "month": month_name(today),
        "hours_used": 0,
        "hours_rolled_over": hours_rolled_over,
        "updated": today.strftime("%Y-%m-%d"),
        "next_invoice": {"date": invoice_label, "amount": data["next_invoice"].get("amount", "")},
        "stats": new_stats,
        "gsc_keywords": gsc_keywords,
        "keywords": updated_keywords,
        "deliverables": reset_deliverables(data.get("deliverables", []), today),
        "content_calendar": build_content_calendar(today),
        "content_choice": reset_content_choice(data),
    })

    with open(portal_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"Reset complete for {slug} — {month_name(today)}")
    print(f"  Clicks: {new_stats['sessions']} ({new_stats['sessions_change']})")
    print(f"  Impressions: {new_stats['impressions']} ({new_stats['impressions_change']})")
    print(f"  Position: {new_stats['position']} ({new_stats['position_change']})")
    print(f"  Keywords: {new_stats['keywords']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python tools/portal-monthly-reset.py <slug>")
        sys.exit(1)
    reset(sys.argv[1])
