# VoltRoute — Bengaluru EV Charging Station Locator

Mobile-first "Google Maps for EV charging stations" for **Bengaluru, Karnataka**.

Core flow: **current location → nearby EV stations → search/filter → station details →
route → distance/ETA → Directions / Open in Maps → Clear route.**

## 1. Architecture (IMPLEMENTED)

```
Browser (index.html + app.js + styles.css, Leaflet CDN, no keys)
  │  same-origin fetch(), 20 s timeout, seq-guards + route cache
  ▼
Express backend (backend/server.js → backend/app.js)
  ├── GET /api/health, GET /api/config (key-free, frontend-safe)
  ├── /api/stations/* → routes/stations.js
  │       ├── services/liveSources.js   Overpass (+OCM if keyed):
  │       │                             External → validate/normalize → dedupe → cache
  │       └── services/stationSource.js curated demo set (fallback) + shared
  │                                      search/detail over live-cache ∪ curated
  └── /api/route → routes/routing.js → services/router.js (OSRM proxy + 5-min cache)
```

Shared station data: every live set the backend fetches stays in the normalized
cache (`getCachedLiveStations()`), so **nearby, search, details, filters, routing,
and map markers all resolve the same representation**. A live pin on the map is
always searchable (`/search`) and selectable (`/:id`).

Static frontend is served by the same Express app: one `npm start` runs everything.
Geolocation is browser-only; the backend sees user coords only as transient
route query params and never stores them.

## 2. Live station provider (IMPLEMENTED)

**Google Places API (New)** is used first when a server-side `GOOGLE_PLACES_API_KEY`
is configured, returning real EV charging-station names, addresses, and coordinates.
It uses Nearby Search's `electric_vehicle_charging_station` type and requests the
minimum map-pin fields only. It is never called by the browser, so the key is not
exposed. When no Google key is configured, **OpenStreetMap Overpass**
(`amenity=charging`, nodes + ways/relations with centers),
configurable via `OVERPASS_URL` (default `https://overpass.kumi.systems/api/interpreter`).
Requests are form-encoded POSTs (`data=<query>`) with a descriptive `User-Agent`
(required by the instance to avoid 429s). Queries use a **bounding box** derived from
lat/lng + radius (spatial-index friendly) with a 15 s server timeout; the client
aborts at 15 s and serves the fallback.

**Normalization** (`liveSources.js`): socket tags → CCS2 / Type 2 / Type 1 / CHAdeMO /
Tesla / GB-T (unknown sockets kept as readable labels, never dropped silently);
power from `socket:*:output` then `capacity`; address from `addr:*` tags;
`updatedAt` from the OSM element timestamp when present. Elements without valid
coordinates are discarded. **Deduplication**: coord (4 decimals) + normalized-name key.
**Caching**: 5-min in-memory TTL (`LIVE_STATION_CACHE_TTL_MS`).

## 3. Fallback provider (IMPLEMENTED)

`backend/data/stations.bengaluru.json` — 18 neighbourhood-approximate demo stations,
loaded once into memory. Served automatically when live fails or returns nothing,
labelled `provider: "curated-demo"` with `fallback: true`; the UI shows
"demo data (live unavailable)" plus `Demo/Fallback` badges. Never deleted.

## 4. Station fields (IMPLEMENTED)

`id, sourceId (e.g. node/123, ocm/456), name, operator, lat, lng, address,
connectors[], powerKw, source, updatedAt, distanceKm` (nearby / detail-with-coords).
Missing operator/connectors/power render as **Unknown** in the UI; `updatedAt`
missing renders as "updated Unknown". Source badges: `Live · OSM`, `Live · OCM`,
`Demo/Fallback`. No availability, pricing, or charger status is shown or inferred —
it does not exist in the data.

## 5. APIs (IMPLEMENTED)

| Method | Endpoint | Behaviour |
|---|---|---|
| GET | `/api/health` | `{ ok, service, time }` |
| GET | `/api/config` | Attribution + city. Never leaks keys (informational) |
| GET | `/api/stations` | Curated demo directory alias |
| GET | `/api/stations/search` | Text search (name/operator/address) over live-cache ∪ curated; reports `provider` + `liveCount` |
| GET | `/api/stations/nearby` | Auto-live default; `source=curated\|osm\|ocm\|google` forces a source; connector filter applied tolerantly |
| GET | `/api/stations/:id` | Shared lookup (live-cache first, curated beneath) + `distanceKm` when coords given |
| GET | `/api/route` | Real OSRM road route: distance + ETA + GeoJSON LineString |
| GET | `/api/traffic-tile/:z/:x/:y` | TomTom flow tile (image/png); 404 JSON when unconfigured, 204 blank on upstream failure |
| GET | `/api/basemap-tile/:z/:x/:y` | CARTO Voyager tile via keyed proxy (image/png); 404 JSON when unconfigured, 204 blank on upstream failure |
| POST | `/api/auth/register` | Create user/owner account (bcrypt, JWT) |
| POST | `/api/auth/login` | Log in (uniform 401, no enumeration) |
| GET | `/api/auth/me` | Profile (Bearer token) |
| POST | `/api/listings` | Owner station submission → live on map (owner role) |
| GET | `/api/listings/mine` | Own submissions (Bearer token) |
| POST | `/api/feedback/choice` | Observed-outcome logging (see §13) |

Errors: bad coords/radius/limit `400`, unknown id `404`, OSRM failure `502`,
no route `404`, OCM-without-key `400`. Unexpected 500s return a generic message
(no stack traces, no provider internals). Rate limit: 120 req/min/IP on `/api/*`.

## 6. Routing (IMPLEMENTED, OSRM kept)

OSRM public demo server proxied via `/api/route` (no key, no frontend contact).
`durationMin` is the OSRM free-flow baseline; when `TOMTOM_API_KEY` is set the
response also carries `traffic` — live congestion sampled along the route with
an ETA integrated from real segment speeds capped at economy pace
(`cruiseKmh` 20–80, default 50; null when unavailable).
Verified: 129-point road geometry, distance + ETA, repeat requests identical
(server cache), invalid coords → 400. Frontend dedupes in-flight route taps and
caches results per origin/destination. Detail card keeps **Directions** (fit route),
**Open in Maps** (Google Maps dir link from the same coords), **Clear Route**.
No turn-by-turn navigation (out of scope).

## 7. Mobile UI (IMPLEMENTED)

Phone-first base CSS (320 px → up): sticky top bar (brand + city + 44 px locate),
sticky search, horizontally scrollable connector chips (All / CCS2 / Type 2 / CHAdeMO),
`52dvh` map (dominant), results as scrollable bottom sheet (`38dvh`), compact detail
card docked to map bottom with wrapping action buttons, safe-area insets, zoom
control top-right (clear of the detail card), short-landscape side-by-side layout.
Desktop (`≥900 px`) shows a compact list + map with a draggable splitter
(list width 240–560 px, persisted, arrow-key accessible).

## 8. Traffic overlay (IMPLEMENTED, optional)

When `TOMTOM_API_KEY` is set, the TomTom relative-flow layer is **auto-enabled**
on the Leaflet map with a **Traffic** entry in the map legend; the filter-row
chip toggles it off/on. Tiles are served
through `GET /api/traffic-tile/:z/:x/:y` so the key never reaches the browser;
`/api/config` advertises only a `trafficOverlay` boolean. Tiles are cached
3 minutes server-side (400-tile cap) and blank (204) on upstream failure so the
map never breaks. Attribution "Traffic © TomTom" is shown with the layer.
Free TomTom key (no card): https://developer.tomtom.com — subject to TomTom's
free-tier quotas. Blank key = chip stays hidden, everything else unchanged.

## 9. Performance (IMPLEMENTED)

Live + route caches, curated load-once, 350 ms debounced typing that filters the
loaded set locally (zero network), sequence guards against stale responses,
client-side connector filtering (no reload request), in-flight route dedup, no
marker redraws on select/close, small payloads (`limit ≤ 100`, OCM compact mode).
No clustering: volume (≤ ~80 pins) does not require it. No new dependencies.

## 10. Accounts and station registration (IMPLEMENTED, needs MySQL)

`register.html` offers Register / Log in with an **EV driver** or **Station owner**
role. Drivers get a login; owners can additionally submit a station (name,
coordinates, connectors, power, operator), which appears on the live map with a
`COMMUNITY` badge and flows into nearby/search/details like any other source.

Implementation: MySQL (`mysql2` driver, `DATABASE_URL`; schema auto-created on
boot in `backend/db.js`), bcrypt-hashed passwords (12 rounds), JWT Bearer tokens
(`JWT_SECRET`, 7-day expiry), no account enumeration on login, 30 req/min on
`/api/auth/*`. Endpoints: `POST /api/auth/register`, `POST /api/auth/login`,
`GET /api/auth/me`, `POST /api/listings` (owner role), `GET /api/listings/mine`.
Prototype simplification: owner submissions are auto-approved — add a moderation
queue before any production use. Without a reachable database the server still
boots and all map/routing features work; only auth/listings fail.

## 11. Environment variables (map/routing key-free; keys only for extras)

| Variable | Default |
|---|---|
| `PORT` / `CORS_ORIGIN` | `3000` / `*` |
| `OSRM_BASE_URL` / `OSRM_TIMEOUT_MS` | demo server / `12000` |
| `OVERPASS_URL` | `https://overpass.kumi.systems/api/interpreter` |
| `OVERPASS_TIMEOUT_MS` / `OVERPASS_USER_AGENT` | `15000` / `VoltRoute-EV-Locator/1.0 …` |
| `LIVE_STATION_CACHE_TTL_MS` | `300000` |
| `GOOGLE_PLACES_API_KEY` (blank = disabled) / `GOOGLE_PLACES_TIMEOUT_MS` | — |
| `CARTO_BASEMAPS_KEY` (blank = key-free light tiles) / `CARTO_TIMEOUT_MS` | — |
| `TOMTOM_API_KEY` (blank = disabled) / `TOMTOM_TIMEOUT_MS` | — |
| `PYTHON_BIN` | `python` on PATH; interpreter with NumPy for the local ML scorer |
| `DATABASE_URL` | MySQL connection (auth/listings only; core APIs work without it) |
| `JWT_SECRET` (dev fallback warns) / `JWT_EXPIRES` | Token secret / `7d` |
| `OCM_API_KEY` (blank = disabled) / `OCM_BASE_URL` / `OCM_TIMEOUT_MS` | — |

`.env` is git-ignored and never committed; `.env.example` holds placeholders only.

## 12. Setup

```bash
npm install
cp .env.example .env   # optional; Windows: Copy-Item .env.example .env
npm start              # → http://localhost:3000 (dev: npm run dev)
```

Accounts/listings additionally need MySQL (map/routing work without it):

```bash
# Create database `voltroute` first (MySQL Workbench: CREATE DATABASE voltroute;)
# Then in .env:
#   DATABASE_URL=mysql://root:@localhost:3306/voltroute  (add :password if your root has one)
#   JWT_SECRET=<long random string>
npm start              # schema auto-creates; register at /register.html
```

## 13. Optimizer foundation and ML ranking (IMPLEMENTED)

The locator now includes a **Vehicle & Range** panel. A user can choose a
prototype vehicle, current battery percentage, and future ranking priority, then
request `GET /api/recommendations/candidates`. The endpoint computes a 20%
range reserve, filters the curated Bengaluru stations by compatible connector and
reachability, resolves each candidate's drive time from a real OSRM road route
with live TomTom traffic (formula fallback per candidate on failure), and
returns a model-ready feature vector per station.

Observed-outcome logging (step 1 toward real-data training) is implemented:
`POST /api/feedback/choice` accepts `{ stationId, action: select|directions|
good|bad, features?, aiScore?, batteryPct?, priority? }` and appends it to the
git-ignored `feedback-choices.jsonl`. The UI logs station taps and Directions
taps silently and offers 👍/👎 buttons in the detail panel. Precise user
coordinates are never accepted or stored; rows are strict-validated (400s).

For the university prototype, availability, crowd, waiting time, price, and
rating are deterministic **simulated** data generated from each station ID.
Traffic congestion (`trafficPct`) is **live TomTom Flow data** per candidate
when `TOMTOM_API_KEY` is set (cached 10 min, clamped to the 5–95 training range;
low-confidence, closed, or failed segments fall back to simulated values).
Every response carries `dataMode: "simulated"` plus per-candidate
`trafficMode: "live"|"simulated"`, a live count, and an explicit notice naming
exactly which fields are live; the UI labels them accordingly. Simulated fields
must not be described as live telemetry.

`ml/generate_dataset.py` creates 20,000 reproducible synthetic station-choice
scenarios. `ml/train_model.py` trains a NumPy feed-forward regression network
(14 inputs → 24 ReLU → 12 ReLU → sigmoid output) and saves its weights plus
feature normalisation to `ml/model/ev_suitability_model.json`. The Express API
calls `ml/predict.py` for the candidate feature batch, returns `aiScore` (0–100),
and ranks the results. The model is intentionally labelled as trained on synthetic
data for an academic prototype.

To reproduce the model on a machine with Python and NumPy:

```bash
pip install -r ml/requirements.txt
python ml/generate_dataset.py
python ml/train_model.py
```

## 14. Limitations (known)

- Public Overpass instances are shared and can be too busy (observed dispatcher
  timeouts); the app then serves labelled demo fallback automatically.
- OSRM demo server: fair-use, no SLA → self-host and set `OSRM_BASE_URL` if throttled.
- OSM/CARTO tiles: free for normal use, attribution required, no bulk scraping.
- Demo data: approximate locations, no live availability/pricing.
- Geolocation needs HTTPS or localhost + permission; denial falls back to Bengaluru.
- Power filter omitted: OSM power tags too sparse to filter reliably.
- Backend search sees live stations only after a nearby call warms the shared cache
  (the app's flow always loads nearby first).

## 15. FUTURE (not implemented)

Neural-network suitability scoring, destination/route-corridor station search,
live charger availability, traffic-aware routing, turn-by-turn navigation, power
filter, user accounts, bookings, reviews, admin. The candidate-generation API now
provides the seam between station discovery and a future trained-model service.





