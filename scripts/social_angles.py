#!/usr/bin/env python3
"""Phoenix Method social angle registry.

One log for every public post (LinkedIn, Instagram, Facebook, Google Business Profile),
so no routine repeats an angle, or a statistic, that another channel already used.

  py -3.14 scripts/social_angles.py list
  py -3.14 scripts/social_angles.py check "copy-pasted location pages read as duplicates" --stat "223 impressions position 75"
  py -3.14 scripts/social_angles.py add --date 2026-11-10 --platform linkedin --keyword "behavioral health seo" --type niche --angle "..." --stat "..." --service "Local SEO" --url https://...
  py -3.14 scripts/social_angles.py sync    # pull content/social front matter + GBP POST_LOG rows not yet logged

`check` exits 1 when the candidate angle shares a concept bucket (or 2+ significant words) with a
post from the last 90 days, or when the candidate stat was already used by any post or blog.
Routines run it before writing and must not proceed on a non-zero exit.
"""
import argparse
import datetime as dt
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOG = ROOT / "content" / "social" / "ANGLE-LOG.md"
SOCIAL = ROOT / "content" / "social"
BLOG = ROOT / "blog"
GBP_LOG = pathlib.Path("C:/Users/kandy/Work/sites/phoenixmethod/gbp-posts/POST_LOG.md")
COLS = ["date", "platform", "keyword", "type", "angle", "stat", "service", "url"]

# Concept buckets: two posts that hit the same bucket are the same angle, whatever the wording.
CONCEPTS = {
    "departed-clinician": ["ghost clinician", "clinician leaves", "clinician left", "someone left", "moves on",
                           "departed", "deleted page", "404", "redirect"],
    "duplicate-pages": ["duplicate", "near-duplicate", "copy-paste", "copy and paste", "pasted", "city swapped",
                        "same paragraph"],
    "stale-site": ["stale", "built once", "never updated", "out of date", "nobody updates", "actually updates"],
    "internal-links": ["internal link", "links to nothing", "dead end", "wired", "linking to nothing"],
    "directory-dependence": ["psychology today", "directory"],
    "site-ownership": ["whose job", "who runs", "who should run", "office manager", "four people"],
    "page-per-service": ["one page per", "page for every", "team page", "one url", "single team page",
                         "page grid", "one service page"],
    "missing-new-hire": ["new clinician", "new hire", "newest clinician", "no page at all"],
    "insurance-list": ["insurance list", "insurance panel", "panels"],
    "telehealth-pages": ["telehealth state", "telehealth page", "state page"],
    "schema": ["schema", "structured data"],
    "indexing": ["request indexing", "url inspection", "not indexed", "crawled - currently"],
    "page-speed": ["page speed", "core web vitals", "lcp", "slow site"],
    "gbp-upkeep": ["business profile", "gbp", "review repl", "reviews"],
    "ai-overviews": ["ai overview", "ai overviews"],
    "cost-objection": ["afford", "agency disappeared", "cheaper", "price"],
    "platform-ceiling": ["squarespace", "wordpress", "platform"],
    "repairs-vs-growth": ["repairs keep", "fixing what breaks", "repairs"],
}
STOP = set("""a an the and or of to in on for with by from at as is are was be it its this that these those your you
we our us i my me they them their he she his her not no but if then than so do does did done has have had can
cannot could would should will may might every each one two three any all some most more less into out up down
over under about after before when where which who whom what why how too very just also only own same other
""".split())
SIG_IGNORE = {"page", "pages", "site", "website", "practice", "practices", "google", "seo", "post", "posts",
              "clinician", "clinicians", "mental", "health", "therapist", "therapists", "group", "small", "search"}


def _norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower())


def concepts(text):
    t = _norm(text)
    return {c for c, keys in CONCEPTS.items() if any(k in t for k in keys)}


def sig_words(text):
    return {w for w in _norm(text).split() if len(w) > 3 and w not in STOP and w not in SIG_IGNORE}


def numbers(text):
    """Distinct numbers in a stat string, e.g. '223 impressions position 75' -> {'223', '75'}."""
    return {n.replace(",", "") for n in re.findall(r"\d[\d,]*\.?\d*", text or "") if len(n.replace(",", "")) >= 2}


def read_log():
    if not LOG.exists():
        return []
    rows = []
    for line in LOG.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|") or line.startswith("| date") or set(line.strip()) <= {"|", "-", " "}:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        cells += [""] * (len(COLS) - len(cells))
        rows.append(dict(zip(COLS, cells[:len(COLS)])))
    return rows


def write_log(rows):
    head = ["# Phoenix Method social angle log", "",
            "ONE row per public post on ANY channel (LinkedIn, Instagram, Facebook, Google Business Profile).",
            "Maintained by `scripts/social_angles.py`; routines run `check` before writing and `add` after posting.",
            "Do not hand-edit the table shape. Angle = the specific point of the post. Stat = the number(s) it cited.",
            "", "| " + " | ".join(COLS) + " |", "|" + "---|" * len(COLS)]
    body = ["| " + " | ".join(r.get(c, "").replace("|", "/") for c in COLS) + " |"
            for r in sorted(rows, key=lambda r: r["date"])]
    LOG.write_text("\n".join(head + body) + "\n", encoding="utf-8")


def front_matter(path):
    txt = path.read_text(encoding="utf-8", errors="replace")
    m = re.match(r"---\r?\n(.*?)\r?\n---", txt, re.S)
    fm = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
    return fm


def external_rows():
    """Rows implied by content/social front matter and the GBP POST_LOG (not yet in the log)."""
    rows = []
    for p in SOCIAL.glob("*/*.md"):
        fm = front_matter(p)
        if not fm.get("date"):
            continue
        rows.append({"date": fm.get("date", ""), "platform": fm.get("platform", ""), "keyword": fm.get("keyword", ""),
                     "type": fm.get("angle_type", ""), "angle": fm.get("angle", ""), "stat": fm.get("stat", ""),
                     "service": fm.get("service", ""),
                     "url": fm.get("live_url") or fm.get("live_url_instagram") or fm.get("blog_url", "")})
    if GBP_LOG.exists():
        for line in GBP_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
            if re.match(r"\|\s*\d{4}-\d{2}-\d{2}", line):
                c = [x.strip() for x in line.strip().strip("|").split("|")]
                rows.append({"date": c[0], "platform": "gbp", "keyword": "", "type": "",
                             "angle": c[2] if len(c) > 2 else "", "stat": "", "service": "",
                             "url": c[3] if len(c) > 3 else ""})
    return rows


def blog_stats():
    """Numbers cited in published blog posts (so social does not re-cite them unless necessary)."""
    out = []
    for p in BLOG.glob("*.html"):
        txt = p.read_text(encoding="utf-8", errors="replace")
        body = re.sub(r"<(script|style).*?</\1>", " ", txt, flags=re.S)
        body = re.sub(r"<[^>]+>", " ", body)
        for m in re.finditer(r"[^.]*Search Console[^.]*\.", body):
            out.append((p.name, m.group(0).strip()))
    return out


def key(r):
    return (r["date"], re.sub(r"\W+", "", r["platform"].lower())[:9])


def cmd_list(_):
    rows = read_log()
    for r in rows:
        print(f"{r['date']}  {r['platform']:<22} {r['type']:<6} {r['angle']}" + (f"   [stat: {r['stat']}]" if r['stat'] else ""))
    missing = [r for r in external_rows() if key(r) not in {key(x) for x in rows}]
    if missing:
        print(f"\nWARNING: {len(missing)} post(s) exist outside this log (run `sync`):")
        for r in missing:
            print(f"  {r['date']} {r['platform']}: {r['angle'] or '(no angle recorded)'}")
        return 2
    return 0


def cmd_sync(_):
    rows = read_log()
    seen = {key(x) for x in rows}
    added = 0
    for r in external_rows():
        if key(r) not in seen:
            rows.append(r)
            seen.add(key(r))
            added += 1
            print(f"added {r['date']} {r['platform']}: {r['angle'] or '(no angle recorded; fill it in)'}")
    write_log(rows)
    print(f"{added} row(s) added; {len(rows)} total")
    return 0


def cmd_add(a):
    rows = read_log()
    row = {"date": a.date, "platform": a.platform, "keyword": a.keyword or "", "type": a.type or "",
           "angle": a.angle, "stat": a.stat or "", "service": a.service or "", "url": a.url or ""}
    rows = [r for r in rows if key(r) != key(row)] + [row]
    write_log(rows)
    print("logged:", row)
    return 0


def cmd_check(a):
    logged = read_log()
    rows = logged + [r for r in external_rows() if key(r) not in {key(x) for x in logged}]
    today = dt.date.today()
    fail = False

    # 1. Angle overlap
    cand_c, cand_w = concepts(a.text), sig_words(a.text)
    print(f"candidate concepts: {sorted(cand_c) or '(none matched; add a bucket to CONCEPTS if this is a new recurring idea)'}")
    hits = []
    for r in rows:
        try:
            age = (today - dt.date.fromisoformat(r["date"][:10])).days
        except ValueError:
            age = 0
        sc, sw = cand_c & concepts(r["angle"]), cand_w & sig_words(r["angle"])
        if sc or len(sw) >= 2:
            hits.append((age, r, sc, sw))
    if not hits:
        print("ANGLE OK: no overlap with any logged post.")
    for age, r, sc, sw in sorted(hits):
        block = age <= a.days
        fail |= block
        print(f"{'ANGLE BLOCK' if block else 'angle old  '} {r['date']} {r['platform']}: {r['angle']}  <- {sorted(sc)} {sorted(sw)}")

    # 2. Stat reuse (any age; a number already cited should not be the post's headline number again)
    if a.stat:
        nums = numbers(a.stat)
        used = []
        for r in rows:
            shared = nums & numbers(r["stat"])
            if shared:
                used.append((f"{r['date']} {r['platform']}", shared))
        for name, sentence in blog_stats():
            shared = nums & numbers(sentence)
            if shared:
                used.append((f"blog/{name}", shared))
        if used:
            fail = True
            print("STAT BLOCK: these numbers were already cited:")
            for where, shared in used:
                print(f"   {where}: {sorted(shared)}")
            print("   Pull a fresh figure (workers/portal/public/pm/data.json gsc_keywords/stats, or a new GSC export) and name its period.")
        else:
            print("STAT OK: numbers not used before.")

    if fail:
        print("\nSTOP: do not write this post as-is. Pick a different section, objection, or statistic.")
        return 1
    print("\nOK to write.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    sub.add_parser("sync").set_defaults(fn=cmd_sync)
    c = sub.add_parser("check")
    c.add_argument("text", help="the candidate angle in plain words")
    c.add_argument("--stat", help="the number(s) the post will cite, e.g. '223 impressions position 75'")
    c.add_argument("--days", type=int, default=90)
    c.set_defaults(fn=cmd_check)
    d = sub.add_parser("add")
    for f in ("date", "platform", "angle"):
        d.add_argument("--" + f, required=True)
    for f in ("keyword", "type", "stat", "service", "url"):
        d.add_argument("--" + f)
    d.set_defaults(fn=cmd_add)
    a = ap.parse_args()
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
