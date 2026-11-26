# VoltRoute — Project Report & File Reference

## 1. Project Overview

### What VoltRoute Is

**VoltRoute** is a mobile-first web application that helps electric-vehicle (EV) drivers locate charging stations around **Bengaluru, Karnataka**, and plan a road route to a selected station. It combines:

- An interactive map (Leaflet + OpenStreetMap/CARTO tiles)
- Live EV charging station discovery (OpenChargeMap API + Overpass fallback)
- Real road routing (OSRM)
- Traffic-aware estimated travel times (TomTom)
- AI-ranked station recommendations (NumPy neural network)
- User accounts + owner station listings (MySQL + bcrypt + JWT)
- Owner station submission form with full charger details

The application is an **academic prototype** developed as a B.Tech Computer Engineering project at Presidency University, Bengaluru (November 2026). It is not a production charging-network service — availability, pricing, and ratings for curated/demo stations are simulated and clearly labelled as such.

### How It Works (User Flow)

```
1. Open http://localhost:3000 (or deployed URL)
   └─► Leaflet map loads with CARTO basemap tiles
   └─► 60+ live OCM charging stations appear as markers in Bengaluru

2. User taps "Use my location" (◎)
   └─► Browser geolocation prompt appears
   └─► Map centers on user, nearby stations load within 25 km

3. User taps a station marker or list card
   └─► Detail card slides up with: name, address, connectors, power, operator,
       charging level, current type, voltage, amperage, status, AI score

4. User taps "Directions"
   └─► If no location: browser prompts for geolocation access
   └─► If granted: OSRM calculates road route with TomTom traffic ETA
   └─► Route polyline drawn on map, distance + duration shown
   └─► "Open in Maps" opens Google Maps navigation

5. User taps "Find feasible chargers" (Vehicle & Range panel)
   └─► Selects vehicle (Tata Nexon EV / MG ZS EV / Ather 450X)
   └─► Sets battery %, charging priority (balanced/fastest/cheapest/shortest)
   └─► Backend returns AI-ranked candidate stations (0–100 suitability score)
   └─► Only stations within usable battery range are shown

6. Station owner taps "Register / Log in"
   └─► Creates account (EV driver or Station owner)
   └─► Owner submits a station (name, coords, connectors, power, etc.)
   └─ Station appears on map with "Community" badge immediately
```

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER (Frontend)                            │
│  index.html  app.js  styles.css  register.html                 │
│  Leaflet CDN (map)                                              │
│                                                                 │
│  • Map rendering, markers, popups                              │
│  • Geolocation prompt & watch                                   │
│  • Station list rendering & filtering                           │
│  • Detail card (slide-up, no map popups)                        │
│  • Route polyline drawing                                       │
│  • API calls to backend (fetch)                                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (same-origin)
┌──────────────────────▼──────────────────────────────────────────┐
│                 EXPRESS BACKEND (backend/)                       │
│                                                                 │
│  app.js          → App assembly, middleware, route mounting     │
│  server.js       → Entry point, dotenv, listen on PORT          │
│                                                                 │
│  routes/                                                                 │
│    stations.js   → GET /api/stations/* (nearby, search, detail)│
│    routing.js    → GET /api/route (OSRM proxy + traffic ETA)   │
│    recommendations.js → GET /api/recommendations/candidates    │
│    auth.js       → POST /api/auth/register/login, GET /me      │
│    listings.js   → POST /api/listings, GET /api/listings/mine  │
│    traffic.js    → GET /api/traffic-tile/:z/:x/:y (TomTom)     │
│    basemap.js    → GET /api/basemap-tile/:z/:x/:y (CARTO)      │
│    feedback.js   → POST /api/feedback/choice                   │
│                                                                 │
│  services/                                                          │
│    stationSource.js   → Live OCM/Overpass + community + curated│
│    liveSources.js     → OCM API, Overpass API, Google Places   │
│    router.js          → OSRM routing proxy + traffic ETA       │
│    trafficFlow.js     → TomTom flow segment data               │
│    mlScorer.js        → Python predict.py OR Node.js port      │
│    auth.js            → bcrypt hash/verify, JWT sign/verify    │
│    listings.js        → MySQL CRUD for station listings        │
│    stationStatus.js   → Simulated station status data          │
│    validate.js        → Request validation middleware          │
│    auth.js (middleware) → authRequired, roleRequired           │
│                                                                 │
│  db.js          → MySQL connection, schema auto-create, retry  │
│                                                                 │
│  data/          → stations.bengaluru.json (curated fallback)   │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (server-side, key never reaches browser)
┌──────────────────────▼──────────────────────────────────────────┐
│              EXTERNAL SERVICES                                    │
│                                                                 │
│  • OpenChargeMap API  → Live EV station data (keyed)            │
│  • Overpass API       → Live OSM charging stations (free)       │
│  • OSRM               → Road routing geometry + duration        │
│  • TomTom API         → Traffic flow tiles + segment speeds     │
│  • CARTO API          → Basemap tiles (keyed)                   │
│  • Google Places      → Optional live station lookup (keyed)    │
│  • MySQL              → Users + station_listings tables         │
│  • Python + NumPy     → ML model training (optional, local only)│
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. File-by-File Reference

### 3.1 Entry Points & Configuration

| File | Purpose | How It Works | Contributes To | Interacts With |
|------|---------|--------------|----------------|----------------|
| **`package.json`** | Project manifest | Declares name, version, dependencies (express, cors, dotenv, mysql2, bcryptjs, jsonwebtoken, express-rate-limit, morgan), scripts (`npm start`, `npm run dev`) | Dependency management, reproducible installs | npm, all backend code |
| **`package-lock.json`** | Locked dependency versions | Ensures identical dependency tree across installs | Consistent deployments | npm |
| **`.env`** (git-ignored) | Local environment secrets | Contains `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES`, `OCM_API_KEY`, `CARTO_BASEMAPS_KEY`, `TOMTOM_API_KEY` | Secure configuration without committing secrets | `backend/server.js` via dotenv |
| **`.env.example`** | Template for `.env` | Placeholder values with comments explaining each variable | Onboarding new developers | Developers copy to `.env` |
| **`backend/server.js`** | Express entry point | Loads dotenv, requires `./app`, starts HTTP server on `PORT` | Boots the entire application | `backend/app.js`, all routes |
| **`backend/app.js`** | App assembly | Creates Express instance, applies CORS/rate-limit/morgan middleware, mounts all routers, serves static frontend, error handler with DB outage classification (503) | Central request orchestration | All route files, `backend/db.js` |
| **`vercel.json`** | Vercel deployment config | Single `@vercel/node` service, routes all paths to `api/index.js` | Enables Vercel serverless deployment | `api/index.js` |
| **`api/index.js`** | Vercel serverless handler | Exports Express app as Vercel function handler | Bridge between Vercel and Express | `backend/app.js` |
| **`Dockerfile`** | Container build | Node 20 Alpine + Python + NumPy, copies repo, runs `npm start` | Alternative deployment (Docker) | All project files |
| **`render.yaml`** | Render.com config | Web service definition with env var placeholders | Alternative deployment (Render) | Render dashboard |

---

### 3.2 Frontend Files

| File | Purpose | How It Works | Contributes To | Interacts With |
|------|---------|--------------|----------------|----------------|
| **`index.html`** | Main map page | HTML structure: header with REGISTER/LOG IN link, search bar, locate button, vehicle/range panel, connector filter chips, results list, map canvas, detail card, footer attribution | Primary user interface | `app.js`, `styles.css`, Leaflet CDN |
| **`register.html`** | Account & station registration | Register/Login tabs, driver-or-owner role selection, optional station submission form (name, coords, connectors, power, phone, tariff, hours, status, image), account panel with "my stations" | User accounts, owner station listings | `backend/routes/auth.js`, `backend/routes/listings.js` |
| **`app.js`** | Frontend application logic | ~770 lines: Leaflet map init, basemap/traffic tile layers, station markers, search, filters, geolocation, routing, detail card, candidate ranking UI, **location prompt on Directions**, **mobile scroll to map** | All interactive map behavior | `backend/` APIs, Leaflet, `styles.css` |
| **`styles.css`** | Frontend styling | CSS variables, mobile-first responsive design (320px+), desktop 3-column workspace with draggable splitter, station cards, detail card, badges, chips, buttons | Visual design, responsive layout | `index.html`, `register.html` |

---

### 3.3 Backend Routes

| File | Purpose | Endpoints | How It Works | Contributes To | Interacts With |
|------|---------|-----------|--------------|----------------|----------------|
| **`backend/routes/stations.js`** | Station discovery | `GET /api/stations/nearby`, `GET /api/stations/search`, `GET /api/stations/:id`, `GET /api/stations` | Calls `stationSource.nearbyStations()` / `searchStations()` which fetch live OCM stations first, falls back to community + curated. Applies connector filter, distance sorting, radius filtering. | Live station map, search, detail | `stationSource.js`, `liveSources.js`, `listings.js` |
| **`backend/routes/routing.js`** | Road routing | `GET /api/route` | Proxies OSRM driving-route endpoint, adds TomTom traffic-aware ETA via `trafficFlow.routeTrafficEta()` | Route polyline, duration, distance | `OSRM`, `TomTom`, `services/router.js` |
| **`backend/routes/recommendations.js`** | AI station ranking | `GET /api/recommendations/candidates` | Filters live stations by connector + battery range, resolves real OSRM route ETAs + live TomTom traffic, scores via ML scorer, returns ranked candidates (0–100) | "Find feasible chargers" panel | `stationSource.js`, `mlScorer.js`, `trafficFlow.js`, `router.js`, `stationStatus.js` |
| **`backend/routes/auth.js`** | Authentication | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | bcrypt-12 password hashing, JWT sign/verify (7-day expiry), duplicate email → 409, wrong password → 401 (uniform, no enumeration), 30 req/min rate limit | User login, session, owner gating | `services/auth.js`, `db.js`, `middleware/auth.js` |
| **`backend/routes/listings.js`** | Owner station submissions | `POST /api/listings` (owner only), `GET /api/listings/mine` | Validates Bengaluru bounds, connectors, power, phone, PIN code; inserts into MySQL; auto-approves; owner listings appear with "Community" badge | Owner station registration, community map data | `services/listings.js`, `db.js`, `middleware/auth.js` |
| **`backend/routes/traffic.js`** | Traffic tile proxy | `GET /api/traffic-tile/:z/:x/:y` | Proxies TomTom traffic flow tiles, server-side caches (3 min, 400-tile cap), returns 204 blank on failure | Traffic overlay layer on map | `TomTom API` |
| **`backend/routes/basemap.js`** | Basemap tile proxy | `GET /api/basemap-tile/:z/:x/:y` | Proxies CARTO Voyager tiles, server-side caches (24h, 300-tile cap) | Map background tiles | `CARTO API` |
| **`backend/routes/feedback.js`** | Feedback logging | `POST /api/feedback/choice` | Appends observed-outcome events (select, directions, good, bad) to git-ignored JSONL file | ML training data collection (future) | `feedback-choices.jsonl` (git-ignored) |

---

### 3.4 Backend Services

| File | Purpose | How It Works | Contributes To | Interacts With |
|------|---------|--------------|----------------|----------------|
| **`backend/services/stationSource.js`** | Shared station data | `nearbyStations()` fetches live OCM/Overpass stations only (no community/curated mixing when live available). `searchStations()` uses cached live stations. `getStationById()` resolves live → community → curated. | All station map pins, search results, detail cards | `liveSources.js`, `listings.js`, `data/stations.bengaluru.json` |
| **`backend/services/liveSources.js`** | Live station providers | `liveFromOCM()` calls OpenChargeMap API with verbose=true (full connector/power/level/status data). `liveFromOverpass()` calls Overpass kumi.systems. `liveFromGooglePlaces()` optional. `getLiveStations()` tries Google → OCM → Overpass. | Live station pins on map | External APIs (OCM, Overpass, Google Places) |
| **`backend/services/router.js`** | OSRM routing | `getRoute()` calls OSRM driving-route, computes distance + baseline duration + GeoJSON geometry, adds traffic-aware ETA via `trafficFlow.routeTrafficEta()` | Road routes, route polylines, ETA | OSRM, `trafficFlow.js` |
| **`backend/services/trafficFlow.js`** | Traffic data | `liveTrafficPct()` gets TomTom flow segment speed → congestion %. `routeTrafficEta()` samples speeds along route geometry → traffic-aware duration. | Traffic overlay, traffic-aware ETA in recommendations | TomTom API |
| **`backend/services/mlScorer.js`** | ML suitability scoring | Tries Python `ml/predict.py` subprocess first; falls back to Node.js `ml/predict.js` port. Validates 14 features, returns scores (0–100) + model version. | AI candidate ranking | `ml/predict.py`, `ml/predict.js`, `ml/model/ev_suitability_model.json` |
| **`backend/services/auth.js`** | Password + JWT | `hashPassword()` (bcrypt-12), `verifyPassword()`, `signToken()` (JWT 7-day), `verifyToken()`, `DUMMY_PASSWORD_HASH` (timing-safe login for unknown emails) | Account security, login sessions | `bcryptjs`, `jsonwebtoken` |
| **`backend/services/listings.js`** | Station listings CRUD | `getApprovedListings()`, `getOwnerListings()`, `createListing()` — MySQL queries with full station fields (phone, tariff, hours, status, image, charging points) | Owner station submissions, community map data | `db.js` |
| **`backend/services/stationStatus.js`** | Simulated status | `simulatedStatus()` generates deterministic crowd/wait/price/availability/rating per station ID | Simulated demo data for curated stations | Recommendations UI |
| **`backend/services/validate.js`** | Request validation | `validateNearby()` checks lat/lng/radius/limit ranges | Input sanitization | All station/route routes |
| **`backend/middleware/auth.js`** | Auth middleware | `authRequired()` checks Bearer JWT, `roleRequired("owner")` restricts endpoints | Protected endpoints (listings, owner-only) | `routes/auth.js`, `routes/listings.js` |
| **`backend/db.js`** | MySQL database | `getPool()` creates mysql2 pool, `initDb()` auto-creates `users` + `station_listings` tables with retry (3 attempts), `healthCheck()` does `SELECT 1`, schema migrations add optional columns | Account storage, owner listings | MySQL 8, all auth/listing routes |

---

### 3.5 ML Files

| File | Purpose | How It Works | Contributes To | Interacts With |
|------|---------|--------------|----------------|----------------|
| **`ml/predict.py`** | Python ML predictor (kept) | Reads `ev_suitability_model.json`, normalizes 14 features, forward-pass through 14→24→12→1 NumPy network, outputs scores (0–100). Called via subprocess by `mlScorer.js` when Python available. | ML scoring on machines with Python + NumPy | `mlScorer.js`, `ml/model/ev_suitability_model.json` |
| **`ml/predict.js`** | Node.js ML port | Pure JavaScript port of `predict.py` — same 14→24→12→1 architecture, same weights, same normalization. No Python dependency. | ML scoring on Vercel/serverless | `mlScorer.js`, `ml/model/ev_suitability_model.json` |
| **`ml/train_model.py`** | Model training | Generates/loads 20,000 synthetic scenarios, 80/20 train-validate split, trains 14→24→12→1 feed-forward network (220 epochs), saves model JSON with validation RMSE (~6.65/100) | Produces the model file | `ml/generate_dataset.py`, `ml/model/ev_suitability_model.json` |
| **`ml/generate_dataset.py`** | Synthetic data generation | Creates 20,000 reproducible EV station-choice scenarios with features and suitability labels | Training data for the model | `ml/train_model.py` |
| **`ml/model/ev_suitability_model.json`** | Trained model | Weights, biases, feature means/stds, version "1.0.0-synthetic", validation RMSE 6.648/100 | ML scoring runtime | `predict.py`, `predict.js`, `mlScorer.js` |
| **`ml/requirements.txt`** | Python deps | `numpy` | Local ML training | `pip install` |

---

### 3.6 Data Files

| File | Purpose | How It Works | Contributes To |
|------|---------|--------------|----------------|
| **`backend/data/stations.bengaluru.json`** | Curated demo stations | 18 approximate Bengaluru charging stations (Tata Power, Ather Grid, BESCOM, ChargeZone, Jio-bp, Statiq, Relux Electric). Served only when live OCM/Overpass fails. | Fallback station data, demo mode |
| **`feedback-choices.jsonl`** (git-ignored) | Feedback log | Append-only JSONL of observed user choices (stationId, action, features, aiScore, batteryPct, priority) | Future ML retraining with real data |

---

### 3.7 Documentation

| File | Purpose |
|------|---------|
| **`README.md`** | Quick start: `npm install`, `npm start`, MySQL setup, Python ML setup, repo hygiene |
| **`DOCUMENTATION.md`** | Detailed technical documentation: architecture, providers, APIs, environment variables, ML details, limitations |
| **`PROJECT_REPORT.md`** | This file — complete file reference + project report |
| **`SYSTEM_DESIGN.md`** | Domain object model (DriverProfile, Vehicle, TripRequest, ChargingStation, etc.) and subsystem flowchart |
| **`CLEANUP_REQUIRED.md`** | Review notes: safe-to-delete items, dependency audit |

---

## 4. Data Flow

### Station Discovery Flow

```
User opens map
    │
    ▼
GET /api/stations/nearby?lat=&lng=&radiusKm=&source=auto
    │
    ▼
stationSource.nearbyStations()
    │
    ├─► liveSources.getLiveStations("auto")
    │       ├─► Google Places (if keyed)
    │       ├─► OpenChargeMap API (keyed, verbose=true) ──► LIVE OCM STATIONS
    │       └─► Overpass API (free)                        ──► LIVE OSM STATIONS
    │
    ├─► If live returns stations → return ONLY live (deduped, by distance)
    ├─► If live fails/empty → community (MySQL) + curated (JSON)
    │
    ▼
filterByConnector() → sort by distance → slice(limit)
    │
    ▼
JSON response: { count, stations[], provider: "openchargemap", live: true }
```

### Routing Flow

```
User taps "Directions" on station detail
    │
    ├─► No location? → getUserLocation() prompt → setUserPos() → scroll to map (mobile)
    │
    ▼
GET /api/route?fromLat=&fromLng=&toLat=&toLng=
    │
    ├─► OSRM: distance + baseline duration + GeoJSON geometry
    ├─► TomTom: flow segment speeds along route → traffic-aware duration
    │
    ▼
JSON: { distanceKm, durationMin, geometry, traffic: {durationMin, trafficPct, samples, cruiseKmh} }
    │
    ▼
Frontend: drawRoute(polyline), showDetail(distance, ETA, traffic %)
```

### Recommendation Flow

```
User taps "Find feasible chargers"
    │
    ├─► No location? → "Please enable your location first" message
    │
    ▼
GET /api/recommendations/candidates?lat=&lng=&batteryKwh=&consumptionKwhPer100Km=&maxDcPowerKw=&batteryPct=&connector=&priority=
    │
    ├─► stationSource.nearbyStations() → live OCM stations
    ├─► filterByConnector() → compatible stations
    ├─► For each: router.getRoute() → real OSRM ETA + TomTom traffic
    ├─► stationStatus.simulatedStatus() → crowd/wait/price/rating (simulated)
    ├─► mlScorer.scoreCandidates() → AI score (Python or Node.js)
    │
    ▼
JSON: { candidates: [{name, aiScore, source, distanceKm, estimatedDriveMin, trafficMode, ...}] }
    │
    ▼
Frontend: ranked station cards, top candidate highlighted
```

### Account / Listing Flow

```
User taps "Register / Log in"
    │
    ├─► Register: POST /api/auth/register → bcrypt-12 hash → MySQL users table → JWT
    ├─► Login: POST /api/auth/login → verify → JWT (uniform 401, no enumeration)
    │
    ▼
Owner taps "Add station"
    │
    ├─► POST /api/listings (owner role required)
    │     ├─► Validate Bengaluru bounds, connectors, power, phone, PIN
    │     ├─► MySQL INSERT → station_listings (auto-approved)
    │
    ▼
Station appears on map with "COMMUNITY" badge
    │
    └─► GET /api/listings/mine → owner's own submissions
```

---

## 5. ML Model Details

### Architecture
- **Type:** Feed-forward neural network regression
- **Layers:** 14 inputs → 24 ReLU → 12 ReLU → 1 sigmoid (output 0–100)
- **Training data:** 20,000 synthetic EV station-choice scenarios
- **Features (14):** distanceKm, estimatedDriveMin, trafficPct, compatible, usablePowerKw, crowdPct, estimatedWaitMin, availabilityRatio, pricePerKwh, batteryPct, rating, priorityFastest, priorityCheapest, priorityShortest
- **Validation RMSE:** 6.648/100 (on synthetic data only)
- **Version:** 1.0.0-synthetic

### Important Notice
> The neural network was trained on synthetic scenarios. Availability, crowd, traffic, waiting time, pricing, and rating are deterministic simulated demo data, not live station telemetry. Traffic congestion (`trafficPct`) is live TomTom Flow data per candidate when `TOMTOM_API_KEY` is set. The model must not be interpreted as a validated real-world predictor.

---

## 6. Environment Variables

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `PORT` | 3000 | No | HTTP server port |
| `DATABASE_URL` | — | No* | MySQL connection for accounts/listings |
| `JWT_SECRET` | dev warning | No* | JWT signing secret |
| `JWT_EXPIRES` | 7d | No | Token expiry |
| `OCM_API_KEY` | — | No | OpenChargeMap live station lookup |
| `CARTO_BASEMAPS_KEY` | — | No | CARTO Voyager basemap tiles |
| `TOMTOM_API_KEY` | — | No | Traffic overlay + traffic-aware ETA |
| `GOOGLE_PLACES_API_KEY` | — | No | Optional Google Places station lookup |
| `PYTHON_BIN` | python | No | Python interpreter for ML (optional) |
| `OSRM_BASE_URL` | demo server | No | OSRM routing backend |
| `OVERPASS_URL` | kumi.systems | No | Overpass API endpoint |

\* Required only for accounts/login functionality. Map/routing/ML work without them.

---

## 7. UX Features

- **Mobile-first responsive design** (320px → desktop)
- **Draggable splitter** on desktop (list width 240–560px, persisted)
- **Location prompt on Directions:** If user hasn't enabled location, tapping Directions triggers `getUserLocation()` browser prompt; on denial, shows fallback message with "Open in Maps" alternative
- **Mobile scroll to map:** After Directions click, page smoothly scrolls to map section on mobile (≤768px)
- **Detail card slide-up:** No popups covering the map; station details appear in a docked card at map bottom
- **Source badges:** "COMMUNITY" for owner listings, "Live · OCM" for OpenChargeMap, "Demo/Fallback" for curated
- **Connector filter chips:** All / CCS2 / Type 2 / CHAdeMO
- **Vehicle & Range panel:** 3 prototype vehicles, battery slider, 4 charging priorities
- **Traffic overlay:** TomTom flow tiles, toggleable, legend entry
- **Rate limiting:** 120 req/min on API, 30 req/min on auth endpoints

---

## 8. Deployment

### Local Development
```powershell
npm install
cp .env.example .env
# Edit .env with your DATABASE_URL and JWT_SECRET
npm start          # → http://localhost:3000
# For ML retraining:
pip install -r ml/requirements.txt
python ml/generate_dataset.py
python ml/train_model.py
```

### Vercel (Serverless)
1. Import `guruPrazad00/Ev-station-locator-and-optimizer` on vercel.com
2. Add env vars in dashboard (DATABASE_URL, JWT_SECRET, TOMTOM_API_KEY, CARTO_BASEMAPS_KEY, OCM_API_KEY)
3. Deploy — `vercel.json` routes all traffic to `api/index.js` (single `@vercel/node` service)

### Docker
```powershell
docker build -t voltroute .
docker run -p 3000:3000 --env-file .env voltroute
```

### Render
1. Connect GitHub repo on render.com
2. `render.yaml` defines web service
3. Add env vars in Render dashboard

---

## 9. Repository Hygiene

- **Git-ignored:** `node_modules/`, `.env`, `__pycache__/`, `*.pyc`, `feedback-choices.jsonl`
- **Never committed:** API keys, JWT secrets, database files, `node_modules`
- **.env.example:** Placeholders only, no real secrets
- **Repo size:** ~1.4 MB (excluding node_modules and .git)

---

*End of Project Report*