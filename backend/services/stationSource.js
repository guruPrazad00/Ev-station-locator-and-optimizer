"use strict";

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "stations.bengaluru.json");

// Curated set is small and static: load once, serve from memory.
let curatedCache = null;

function loadCurated() {
  if (!curatedCache) {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    curatedCache = JSON.parse(raw);
  }
  return curatedCache;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function filterByConnector(stations, connector) {
  if (!connector || connector === "all") return stations;
  // Match against the connector strings exactly as provided by OCM/Overpass.
  // Case-insensitive substring match both directions.
  const want = String(connector).toLowerCase();
  const filtered = stations.filter((s) =>
    (s.connectors || []).some((c) => {
      const cl = String(c).toLowerCase();
      return cl.includes(want) || want.includes(cl);
    })
  );
  // If the filter eliminated everything, return all stations unfiltered
  // so users still see live OCM data rather than an empty list.
  return filtered.length > 0 ? filtered : stations;
}

// Owner-approved community listings (MySQL). Lazy-required and
// failure-isolated so a database problem can never break the core station
// endpoints — callers treat a rejection as "no community stations".
async function communityStations() {
  try {
    return await require("./listings").getApprovedListings();
  } catch {
    return [];
  }
}

function matchesText(s, needle) {
  return (
    (s.name || "").toLowerCase().includes(needle) ||
    (s.address || "").toLowerCase().includes(needle) ||
    (s.operator || "").toLowerCase().includes(needle)
  );
}

// Fetch live stations from OCM → Overpass. Returns [] on failure.
async function fetchLiveStations(lat, lng, radiusKm, source = "auto") {
  try {
    const { getLiveStations } = require("./liveSources");
    const result = await getLiveStations(lat, lng, radiusKm, source);
    return Array.isArray(result.stations) ? result.stations : [];
  } catch {
    return [];
  }
}

// Sort + distance-annotate + slice. Shared by nearbyStations and searchStations.
function rankAndSlice(stations, lat, lng, radiusKm, connector, limit) {
  stations = filterByConnector(stations, connector);
  return stations
    .map((s) => {
      const d = lat != null && lng != null ? haversineKm(lat, lng, s.lat, s.lng) : null;
      return { ...s, distanceKm: d != null ? Math.round(d * 100) / 100 : null };
    })
    .filter((s) => s.distanceKm != null && s.distanceKm <= radiusKm)
    .sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0))
    .slice(0, limit);
}

// nearbyStations: return ONLY live OCM/Overpass stations when available.
// If live fails or returns nothing, fall back to community + curated.
async function nearbyStations({ lat, lng, radiusKm, connector, limit, source = "auto" }) {
  const live = await fetchLiveStations(lat, lng, radiusKm, source);

  if (live.length > 0) {
    return rankAndSlice(live, lat, lng, radiusKm, connector, limit);
  }

  // Live failed or empty → fall back to community + curated demo.
  let stations = [...(await communityStations()), ...loadCurated()];
  return rankAndSlice(stations, lat, lng, radiusKm, connector, limit);
}

// searchStations: use cached live stations if available; else community + curated.
async function searchStations({ q, connector, limit, extra = [] }) {
  let liveStations = [];
  try {
    const { getCachedLiveStations } = require("./liveSources");
    liveStations = Array.isArray(getCachedLiveStations()) ? getCachedLiveStations() : [];
  } catch { /* live cache unavailable */ }

  const stations = liveStations.length > 0
    ? liveStations
    : [...(await communityStations()), ...loadCurated()];

  const seen = new Set();
  const deduped = [];
  for (const s of [...extra, ...stations]) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }

  let result = deduped;
  if (q) {
    const needle = String(q).toLowerCase();
    result = result.filter((s) => matchesText(s, needle));
  }
  result = filterByConnector(result, connector);
  return result.slice(0, limit);
}

async function getStationById(id, extra = []) {
  // Live-cached stations first so a mapped live station is always selectable.
  const live = (extra || []).find((s) => s && s.id === id);
  if (live) return live;
  const community = (await communityStations()).find((s) => s && s.id === id);
  if (community) return community;
  return loadCurated().find((s) => s.id === id) || null;
}

module.exports = {
  loadCurated,
  haversineKm,
  filterByConnector,
  searchStations,
  nearbyStations,
  getStationById,
  fetchLiveStations,
};
