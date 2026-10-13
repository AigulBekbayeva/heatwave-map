"""Download daily max temperature (ERA5 via Open-Meteo) for every sampling point.

Incremental and resumable: each point lives in data/raw/<key>.csv and only the
missing days (from START, or after the last stored day) are requested. Points
are processed in the order of data/points.csv (most populous first).

Free tier (no key): Open-Meteo counts a long request as several calls
(roughly one call per 14 days per location), with limits of 600/min,
5,000/hour and 10,000/day. 2000→today is ~700 calls per point, so the full
history for ~176 points takes about two weeks of daily runs. The script paces
itself and stops cleanly when the budget for this run is used up.

With OPEN_METEO_API_KEY set, it uses the customer endpoint and no budget.

Usage:
  python scripts/fetch.py [--budget 9000] [--max-minutes 330]
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
START = dt.date(2000, 1, 1)
ERA5_LAG_DAYS = 6          # ERA5 on Open-Meteo is published with ~5 days delay
CHUNK_DAYS = 4 * 365       # ~104 calls per request, stays below the per-minute cap
PER_MINUTE = 550
PER_HOUR = 4800


def point_key(row):
    return f"{row['iso']}_{float(row['lat']):+.2f}_{float(row['lon']):+.2f}"


def weight(days):
    return max(1.0, days / 14.0)


def last_stored_day(path):
    if not path.exists():
        return None
    last = None
    with open(path) as fh:
        for line in fh:
            if line[:1].isdigit():
                last = line.split(",", 1)[0]
    return dt.date.fromisoformat(last) if last else None


class Pacer:
    """Sliding-window limiter for the per-minute and per-hour call caps."""

    def __init__(self, budget, enabled=True):
        self.budget, self.enabled, self.used = budget, enabled, 0.0
        self.log = deque()

    def _in(self, seconds, now):
        return sum(w for t, w in self.log if now - t < seconds)

    def can_spend(self, w):
        return not self.enabled or self.used + w <= self.budget

    def wait(self, w):
        if not self.enabled:
            return
        while True:
            now = time.time()
            while self.log and now - self.log[0][0] > 3600:
                self.log.popleft()
            if self._in(60, now) + w <= PER_MINUTE and self._in(3600, now) + w <= PER_HOUR:
                return
            time.sleep(5)

    def spend(self, w):
        self.used += w
        self.log.append((time.time(), w))


class DailyLimit(Exception):
    pass


class OutOfBudget(Exception):
    pass


def request(lat, lon, start, end, apikey):
    host = "customer-archive-api.open-meteo.com" if apikey else "archive-api.open-meteo.com"
    q = {
        "latitude": lat, "longitude": lon,
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": "temperature_2m_max", "timezone": "auto", "models": "era5",
    }
    if apikey:
        q["apikey"] = apikey
    url = f"https://{host}/v1/archive?" + urllib.parse.urlencode(q)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code == 429:
                if "daily" in body.lower() or "monthly" in body.lower():
                    raise DailyLimit(body)
                time.sleep(65)          # minutely / hourly cap: back off and retry
                continue
            if e.code >= 500:
                time.sleep(20 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}: {body}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  network error ({e}), retrying", flush=True)
            time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}")


def append_rows(path, times, values):
    new = not path.exists()
    with open(path, "a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["date", "tmax"])
        for t, v in zip(times, values):
            w.writerow([t, "" if v is None else v])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=9000, help="max Open-Meteo calls this run (free tier)")
    ap.add_argument("--max-minutes", type=float, default=330, help="stop starting new requests after this")
    args = ap.parse_args()

    apikey = os.environ.get("OPEN_METEO_API_KEY") or None
    pacer = Pacer(args.budget, enabled=apikey is None)
    deadline = time.time() + args.max_minutes * 60
    end = dt.date.today() - dt.timedelta(days=ERA5_LAG_DAYS)
    RAW.mkdir(parents=True, exist_ok=True)

    points = list(csv.DictReader(open(ROOT / "data" / "points.csv")))
    done = fetched = 0
    try:
        for row in points:
            path = RAW / f"{point_key(row)}.csv"
            last = last_stored_day(path)
            cur = START if last is None else last + dt.timedelta(days=1)
            while cur <= end:
                stop = min(end, cur + dt.timedelta(days=CHUNK_DAYS - 1))
                w = weight((stop - cur).days + 1)
                if not pacer.can_spend(w) or time.time() > deadline:
                    raise OutOfBudget
                pacer.wait(w)
                data = request(row["lat"], row["lon"], cur, stop, apikey)
                pacer.spend(w)
                times = data["daily"]["time"]
                vals = data["daily"]["temperature_2m_max"]
                while vals and vals[-1] is None:   # not yet published: refetch next run
                    vals.pop(); times.pop()
                if not times:
                    break
                append_rows(path, times, vals)
                fetched += 1
                print(f"  {row['iso']:>3} {row['place']}: {times[0]} → {times[-1]}  (used {pacer.used:.0f})", flush=True)
                cur = dt.date.fromisoformat(times[-1]) + dt.timedelta(days=1)
                if len(times) < (stop - dt.date.fromisoformat(times[0])).days + 1:
                    break                           # API returned less than asked
            done += 1
    except OutOfBudget:
        print("Budget or time limit for this run reached; continuing next run.")
    except DailyLimit as e:
        print(f"Open-Meteo daily limit reached; continuing next run. ({e})")

    print(f"Points up to date: {done}/{len(points)}; requests this run: {fetched}; calls used: {pacer.used:.0f}")


if __name__ == "__main__":
    sys.exit(main())
