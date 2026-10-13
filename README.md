# 🔥 Global Heatwave Map · 2000 → 2026

Interactive world map of **heatwave days per country, every year since 2000**, built from ERA5 reanalysis and updated daily by GitHub Actions.

**Live map:** `https://<user>.github.io/<repo>/`

- Year slider with a play button (2000 → 2026)
- "Change vs 2000–09" view: 2016–2025 average minus the 2000–2009 average
- Click a country for its year-by-year bars; hover for a sparkline
- **PNG** button exports a 1080×1350 image sized for a LinkedIn post
- Data table on the page and a downloadable CSV (`web/data/heatwave_days.csv`)

## Definition

For each location:

1. **Threshold.** For every calendar day, the 95th percentile of daily maximum temperature over 2000–2025, using all days within ±7 days of that date (15-day window × 26 years = 390 values).
2. **Hot day.** Daily Tmax strictly above that day's threshold.
3. **Heatwave.** A run of **≥ 3 consecutive hot days**. Every day in the run is a heatwave day.

A country's value is the mean over its sampling points. By default each country has one point: its **capital** (largest city or label point where no capital is listed).

Because the threshold is local and seasonal, the map shows how often each place gets heat that is unusual *for that place and time of year* — Oslo and Riyadh are on the same scale.

## Data

- **ERA5** (ECMWF / Copernicus Climate Change Service), ~0.25° grid, via the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) with `models=era5`, `daily=temperature_2m_max`, `timezone=auto` (local-time days).
- Country shapes and capitals: [Natural Earth](https://www.naturalearthdata.com/) (public domain), 1:110m.

### Caveats

- **One point per large country.** Russia, the USA or Kazakhstan are represented by their capital's grid cell. Add rows to `data/points.csv` with the same `iso` to sample more locations; they are averaged automatically.
- **In-sample baseline.** 2000–2025 includes recent warm years. Against an older baseline (e.g. 1961–1990) heatwave days and trends would be larger, so this is the conservative choice.
- **The latest year is partial** (labelled "to date" on the map).
- **Reanalysis, not stations.** ERA5 smooths extremes in coastal and mountainous cells.

## How it runs

```
data/points.csv ──► scripts/fetch.py ──► data/raw/*.csv ──► scripts/compute.py ──► web/data/*.json ──► GitHub Pages
                    (Open-Meteo, resumable)                  (percentiles, runs)
```

| Workflow | Trigger | What it does |
|---|---|---|
| `update-data.yml` | daily 00:17 UTC, manual, changes to scripts/points | fetch new days → compute → commit data → deploy |
| `deploy-site.yml` | changes in `web/` | recompute from committed data → deploy (no download) |

### First download takes about two weeks on the free tier

Open-Meteo counts a long request as roughly one call per 14 days of data per location, with free limits of 600/min, 5,000/hour and 10,000/day. 2000 → today is ~700 calls per point, so the full history for 176 points is ~123,000 calls. The fetcher paces itself to ~9,000 calls per daily run, saves progress after every request and starts with the most populous countries; the map fills in country by country and shows a progress bar meanwhile. After that, daily updates cost only a few hundred calls.

To get everything in one run, add an [Open-Meteo API key](https://open-meteo.com/en/pricing) as the repository secret `OPEN_METEO_API_KEY` and run the workflow manually.

## Setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Actions → Update ERA5 data & deploy → Run workflow** (or wait for the nightly run).
3. Optional: add the `OPEN_METEO_API_KEY` secret.

## Run locally

```bash
pip install -r requirements.txt
python scripts/fetch.py --budget 2000     # needs internet access to Open-Meteo
python scripts/compute.py
python -m http.server -d web 8000         # open http://localhost:8000
```

`scripts/build_geo.py` regenerates `web/data/countries.geojson` and `data/points.csv` from Natural Earth files; it only needs to run again if you change the country set.

## License

Code: MIT. Data: ERA5 under the Copernicus licence (contains modified Copernicus Climate Change Service information); Open-Meteo data under CC BY 4.0; Natural Earth public domain.
