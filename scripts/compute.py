"""Count heatwave days per country and year from the raw ERA5 series.

Definition (per sampling point):
  * threshold(d) = 95th percentile of daily Tmax over the baseline years
    2000–2025, using all days within ±7 calendar days of day-of-year d
    (a 15-day moving window, 26 years × 15 days = 390 values per threshold);
  * a "hot day" has Tmax strictly above threshold(d) for its calendar day;
  * a heatwave is a run of ≥ 3 consecutive hot days;
  * every day inside such a run is a heatwave day.
A country's value is the mean over its sampling points (one by default).

Outputs:
  web/data/heatwaves.json   everything the map needs
  web/data/heatwave_days.csv  tidy table: iso, country, place, year, days, events
"""
import csv
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"

FIRST_YEAR = 2000
BASELINE = (2000, 2025)
PCTL = 95
HALF_WINDOW = 7
MIN_RUN = 3
# A point counts as complete when its series reaches this close to the newest data.
COMPLETE_TOLERANCE_DAYS = 10


def point_key(row):
    return f"{row['iso']}_{float(row['lat']):+.2f}_{float(row['lon']):+.2f}"


def day_index(dates):
    """0..364 calendar-day index; Feb 29 shares Feb 28's slot."""
    idx = dates.dayofyear.values - 1
    leap = dates.is_leap_year
    after_feb28 = leap & (dates.dayofyear.values >= 60)
    return np.where(after_feb28, idx - 1, idx)


def thresholds(idx, tmax, base_mask):
    vals, ids = tmax[base_mask], idx[base_mask]
    ok = ~np.isnan(vals)
    vals, ids = vals[ok], ids[ok]
    thr = np.full(365, np.nan)
    for d in range(365):
        dist = np.abs(ids - d)
        dist = np.minimum(dist, 365 - dist)
        sel = vals[dist <= HALF_WINDOW]
        if sel.size >= 100:
            thr[d] = np.percentile(sel, PCTL)
    return thr


def heatwave_flags(hot):
    """Mark days that belong to a run of >= MIN_RUN consecutive True values."""
    flags = np.zeros_like(hot)
    n, i = len(hot), 0
    while i < n:
        if hot[i]:
            j = i
            while j < n and hot[j]:
                j += 1
            if j - i >= MIN_RUN:
                flags[i:j] = True
            i = j
        else:
            i += 1
    return flags


def analyse(path, last_year):
    df = pd.read_csv(path, parse_dates=["date"])
    df = df.drop_duplicates("date").set_index("date").sort_index()
    full = pd.date_range(f"{FIRST_YEAR}-01-01", df.index.max(), freq="D")
    df = df.reindex(full)                       # gaps become NaN and break runs
    tmax = df["tmax"].to_numpy(dtype=float)
    idx = day_index(full)
    years = full.year.values
    base = (years >= BASELINE[0]) & (years <= BASELINE[1])

    thr = thresholds(idx, tmax, base)
    with np.errstate(invalid="ignore"):
        hot = tmax > thr[idx]                   # NaN compares False
    hw = heatwave_flags(hot)
    starts = hw & ~np.concatenate([[False], hw[:-1]])

    out = {"days": [], "events": [], "coverage": []}
    for y in range(FIRST_YEAR, last_year + 1):
        m = years == y
        n_days = 366 if pd.Timestamp(y, 12, 31).dayofyear == 366 else 365
        out["days"].append(int(hw[m].sum()))
        out["events"].append(int(starts[m].sum()))
        out["coverage"].append(round(float((~np.isnan(tmax[m])).sum()) / n_days, 3))
    summer = np.nanmax(thr) if np.isfinite(thr).any() else None
    out["peak_threshold_c"] = None if summer is None else round(float(summer), 1)
    out["last_date"] = df["tmax"].last_valid_index().date().isoformat()
    return out


def main():
    points = list(csv.DictReader(open(ROOT / "data" / "points.csv")))
    files = {point_key(r): RAW / f"{point_key(r)}.csv" for r in points}
    present = {k: p for k, p in files.items() if p.exists() and p.stat().st_size > 100}
    if not present:
        newest = None
    else:
        newest = max(pd.read_csv(p, usecols=["date"])["date"].max() for p in present.values())
        newest = dt.date.fromisoformat(newest)

    countries, rows = {}, []
    last_year = newest.year if newest else FIRST_YEAR
    for r in points:
        k = point_key(r)
        if k not in present:
            continue
        res = analyse(present[k], last_year)
        if (newest - dt.date.fromisoformat(res["last_date"])).days > COMPLETE_TOLERANCE_DAYS:
            continue                             # history still being downloaded
        c = countries.setdefault(r["iso"], {"name": r["country"], "points": []})
        c["points"].append({"place": r["place"], "lat": float(r["lat"]), "lon": float(r["lon"]), **res})

    for iso, c in countries.items():
        pts = c["points"]
        c["days"] = [round(float(np.mean([p["days"][i] for p in pts])), 1) for i in range(len(pts[0]["days"]))]
        c["events"] = [round(float(np.mean([p["events"][i] for p in pts])), 1) for i in range(len(pts[0]["events"]))]
        early = np.mean(c["days"][0:10])         # 2000–2009
        late = np.mean(c["days"][16:26]) if len(c["days"]) >= 26 else np.nan   # 2016–2025
        c["mean_2000s"] = round(float(early), 1)
        c["mean_recent"] = None if np.isnan(late) else round(float(late), 1)
        c["change"] = None if np.isnan(late) else round(float(late - early), 1)
        for p in pts:
            for i, y in enumerate(range(FIRST_YEAR, last_year + 1)):
                rows.append([iso, c["name"], p["place"], y, p["days"][i], p["events"][i], p["coverage"][i]])

    meta = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "data_through": newest.isoformat() if newest else None,
        "first_year": FIRST_YEAR,
        "last_year": last_year,
        "baseline": list(BASELINE),
        "definition": f">= {MIN_RUN} consecutive days with daily Tmax above the local {PCTL}th percentile "
                      f"for that calendar day ({BASELINE[0]}–{BASELINE[1]}, ±{HALF_WINDOW}-day window)",
        "source": "ERA5 reanalysis (Copernicus/ECMWF) via the Open-Meteo Historical Weather API",
        "countries_done": len(countries),
        "countries_total": len({r["iso"] for r in points}),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "heatwaves.json", "w") as fh:
        json.dump({"meta": meta, "countries": countries}, fh, separators=(",", ":"))
    with open(OUT / "heatwave_days.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["iso", "country", "place", "year", "heatwave_days", "heatwave_events", "data_coverage"])
        w.writerows(rows)
    print(f"{len(countries)}/{meta['countries_total']} countries; data through {meta['data_through']}")


if __name__ == "__main__":
    main()
