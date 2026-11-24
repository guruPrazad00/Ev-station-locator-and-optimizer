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

### With MySQL (accounts + owner station listings)

Create the `voltroute` database first, then point `.env` at it:

```bash
# In MySQL Workbench or mysql CLI:
CREATE DATABASE voltroute;

# .env:
DATABASE_URL=mysql://root:root@localhost:3306/voltroute
JWT_SECRET=<long random string>
JWT_EXPIRES=7d
```

Then `npm start` — schema auto-creates on boot, register at `http://localhost:3000/register.html`.

### With Python + NumPy (ML scorer)

```bash
pip install -r ml/requirements.txt
python ml/generate_dataset.py
python ml/train_model.py
```

The saved model at `ml/model/ev_suitability_model.json` reports validation RMSE 6.65/100 on synthetic data.

## Stack

Express backend (one `npm start` serves API + frontend) · Leaflet + OpenStreetMap ·
OSRM routing · Overpass live stations with curated fallback · TomTom traffic ·
NumPy neural ranker (14→24→12→1, RMSE 6.65/100) · MySQL accounts (bcrypt + JWT).

## Repo hygiene

`node_modules/`, `.env`, `__pycache__/`, and `feedback-choices.jsonl` are
git-ignored and never committed. No secrets live anywhere except your local `.env`.
