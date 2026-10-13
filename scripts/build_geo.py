"""One-off: build the country shapes for the map and the sampling points.

Inputs  (Natural Earth, public domain):
  ne_110m_admin_0_countries.geojson
  ne_50m_populated_places_simple.geojson
Outputs:
  web/data/countries.geojson   simplified shapes, properties {iso, name}
  data/points.csv              one sampling point per country (the capital)

Usage:
  python scripts/build_geo.py <dir-with-natural-earth-geojson>

data/points.csv is meant to be edited by hand: add more rows with the same
`iso` to sample a country at several locations (values are averaged).
"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def rnd(coords, nd=2):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    return [rnd(c, nd) for c in coords]


# Hand fixes for stale or missing Natural Earth names/places.
OVERRIDES = {
    "KAZ": ("Astana", 51.169, 71.449, "capital"),       # renamed from Nur-Sultan in 2022
    "SDS": ("Juba", 4.859, 31.571, "capital"),
    "PSX": ("Ramallah", 31.903, 35.204, "administrative capital"),
    "CYN": ("North Nicosia", 35.185, 33.363, "capital"),
}


def main(src):
    src = Path(src)
    countries = json.load(open(src / "ne_110m_admin_0_countries.geojson"))
    places = json.load(open(src / "ne_50m_populated_places_simple.geojson"))

    by_a3 = {}
    for f in places["features"]:
        p = f["properties"]
        by_a3.setdefault(p["adm0_a3"], []).append(p)

    feats, points = [], []
    for f in countries["features"]:
        p = f["properties"]
        iso, name = p["ADM0_A3"], p["NAME"]
        if iso == "ATA":  # Antarctica
            continue
        g = f["geometry"]
        feats.append({
            "type": "Feature",
            "properties": {"iso": iso, "name": name},
            "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])},
        })
        cands = by_a3.get(iso, [])
        cap = [c for c in cands if c["featurecla"] == "Admin-0 capital"]
        if iso in OVERRIDES:
            pt = OVERRIDES[iso]
        elif cap:
            c = max(cap, key=lambda c: c["pop_max"] or 0)
            pt = (c["name"], c["latitude"], c["longitude"], "capital")
        elif cands:
            c = max(cands, key=lambda c: c["pop_max"] or 0)
            pt = (c["name"], c["latitude"], c["longitude"], "largest city")
        else:
            pt = (name + " (label point)", p["LABEL_Y"], p["LABEL_X"], "label point")
        points.append({
            "iso": iso, "country": name, "place": " ".join(pt[0].split()),
            "lat": round(pt[1], 3), "lon": round(pt[2], 3),
            "kind": pt[3], "pop": int(p["POP_EST"] or 0),
        })

    (ROOT / "web/data").mkdir(parents=True, exist_ok=True)
    with open(ROOT / "web/data/countries.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
    with open(ROOT / "data/points.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(points[0].keys()))
        w.writeheader()
        # Row order is the fetch order: most populous countries first.
        w.writerows(sorted(points, key=lambda r: -r["pop"]))
    print(f"{len(feats)} countries, {len(points)} points")


if __name__ == "__main__":
    main(sys.argv[1])
