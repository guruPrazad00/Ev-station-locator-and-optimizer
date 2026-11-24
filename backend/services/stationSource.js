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
  // Tolerant match: upstream labels vary ("CCS (Type 2 Combo)" ≈ "CCS2").
  const want = String(connector).toLowerCase();
  return stations.filter((s) =>
    (s.connectors || []).some((c) => {
      const cl = String(c).toLowerCase();
      return cl === want || cl.includes(want) || want.includes(cl);
    })
  );
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

async function searchStations({ q, connector, limit, extra = [] }) {
  // Shared data = live-cached stations first, curated demo set beneath.
  // Community listings are appended after live extras (they carry their own ids).
  const seen = new Set();
  const combined = [];
  for (const s of [...extra, ...(await communityStations()), ...loadCurated()]) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    combined.push(s);
  }
  let stations = combined;
  if (q) {
    const needle = String(q).toLowerCase();
    stations = stations.filter((s) => matchesText(s, needle));
  }
  stations = filterByConnector(stations, connector);
  return stations.slice(0, limit);
}

async function nearbyStations({ lat, lng, radiusKm, connector, limit }) {
  let stations = [...(await communityStations()), ...loadCurated()];
  stations = filterByConnector(stations, connector);
  return stations
    .map((s) => ({ ...s, distanceKm: haversineKm(lat, lng, s.lat, s.lng) }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map((s) => ({ ...s, distanceKm: Math.round(s.distanceKm * 100) / 100 }))
    .slice(0, limit);
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
};
