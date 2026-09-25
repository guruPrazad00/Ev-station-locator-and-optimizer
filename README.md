# VoltRoute — Bengaluru EV Charging Station Locator

Mobile-first "Google Maps for EV charging stations" for **Bengaluru, Karnataka**:
live map + user location + station markers + details + real road routing with
live-traffic ETAs, plus an ML-ranked candidate mode and owner station listings.

## Run it

```bash
npm install
cp .env.example .env   # Windows: Copy-Item .env.example .env
npm start              # → http://localhost:3000
```

No API keys required for the base app (map, stations, routing, search, filters).
Optionals: MySQL for accounts (`register.html`), TomTom key for the traffic
overlay + live congestion ranking, Google Places / CARTO / OCM keys. Python +
NumPy only needed for the ML scorer. Details in [DOCUMENTATION.md](DOCUMENTATION.md).

## Stack

Express backend (one `npm start` serves API + frontend) · Leaflet + OpenStreetMap ·
OSRM routing · Overpass live stations with curated fallback · TomTom traffic ·
NumPy neural ranker (14→24→12→1, RMSE 6.65/100) · MySQL accounts (bcrypt + JWT).

## Repo hygiene

`node_modules/`, `.env`, `__pycache__/`, and `feedback-choices.jsonl` are
git-ignored and never committed. No secrets live anywhere except your local `.env`.
