"use strict";

const express = require("express");
const {
  searchStations,
  nearbyStations,
  getStationById,
  filterByConnector,
  haversineKm,
} = require("../services/stationSource");
const { getLiveStations, getCachedLiveStations } = require("../services/liveSources");
const { validateNearby } = require("../middleware/validate");

const router = express.Router();

// Curated JSON is demo/fallback data (approximate locations) — labelled as such.
const CURATED_PROVIDER = "curated-demo";

function applyConnector(stations, connector, limit) {
  return filterByConnector(stations, connector).slice(0, limit);
}

// GET /api/stations/search?q=&connector=&limit=
// Searches the shared station data: cached live stations first,
// curated demo set beneath (a live map pin is always searchable).
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q || "").toString().trim().slice(0, 100);
    const connector = (req.query.connector || "all").toString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const live = getCachedLiveStations();
    const results = await searchStations({ q, connector, limit, extra: live });
    const liveCount = results.filter((s) => s.source === "openstreetmap" || s.source === "openchargemap").length;
    res.json({
      count: results.length,
      stations: results,
      provider: liveCount ? "mixed-live+curated-demo" : CURATED_PROVIDER,
      liveCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/stations/nearby?lat=&lng=&radiusKm=&connector=&limit=&source=
// Default pipeline: live stations (OCM if configured, else Overpass) →
// validate/normalize/dedupe in liveSources → frontend.
// Curated demo set is the fallback when live fails or returns nothing.
// `source=curated` forces the demo set; `source=osm|ocm|google` forces a live source.
router.get("/nearby", async (req, res, next) => {
  try {
    const parsed = validateNearby(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { lat, lng, radiusKm, limit } = parsed;
    const connector = (req.query.connector || "all").toString().slice(0, 30);
    const source = (req.query.source || "").toString().toLowerCase();
    const wantLive = String(req.query.live || "").toLowerCase() === "true";

    const curated = async () => {
      const stations = applyConnector(
        await nearbyStations({ lat, lng, radiusKm, connector: "all", limit: 100 }),
        connector,
        limit
      );
      return { count: stations.length, stations, live: false, provider: CURATED_PROVIDER };
    };

    if (source === "curated") {
      return res.json(await curated());
    }

    try {
      const live = await getLiveStations(
        lat,
        lng,
        radiusKm,
        wantLive || source === "osm" || source === "ocm" || source === "google" ? source || "auto" : "auto"
      );
      const withDistance = live.stations
        .map((s) => ({ ...s, distanceKm: Math.round(haversineKm(lat, lng, s.lat, s.lng) * 100) / 100 }))
        .filter((s) => s.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      const filtered = applyConnector(withDistance, connector, limit);
      if (filtered.length) {
        return res.json({ count: filtered.length, stations: filtered, live: true, provider: live.provider });
      }
      // Live returned nothing usable → curated fallback.
      return res.json({ ...(await curated()), fallback: true });
    } catch (err) {
      // Live source failure → curated fallback (error surfaced via fallback flag).
      if (err.status === 400) return res.status(400).json({ error: err.message });
      return res.json({ ...(await curated()), fallback: true });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/stations/:id
// Resolves against the same shared data (live-cached first, curated beneath).
router.get("/:id", async (req, res, next) => {
  try {
    const station = await getStationById(req.params.id, getCachedLiveStations());
    if (!station) return res.status(404).json({ error: "Station not found." });
    const { lat, lng } = req.query;
    if (lat !== undefined && lng !== undefined) {
      const la = Number(lat);
      const ln = Number(lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        return res.json({ ...station, distanceKm: Math.round(haversineKm(la, ln, station.lat, station.lng) * 100) / 100 });
      }
    }
    res.json(station);
  } catch (err) {
    next(err);
  }
});

// GET /api/stations  (alias of search, no query = all curated demo stations)
router.get("/", async (req, res, next) => {
  try {
    const connector = (req.query.connector || "all").toString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const stations = await searchStations({ q: "", connector, limit });
    res.json({ count: stations.length, stations, provider: CURATED_PROVIDER });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
