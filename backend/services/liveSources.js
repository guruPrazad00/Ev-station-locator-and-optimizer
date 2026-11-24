"use strict";

// Live lookups against free, no-key sources:
//  - OpenStreetMap Overpass API (amenity=charging) — primary live source
//  - OpenChargeMap — only when OCM_API_KEY is configured
//
// Pipeline: External API → validate/normalize → deduplicate → frontend.
// Failures throw so routes can fall back to the curated Bengaluru dataset.
// Never invents missing info: fields absent upstream are omitted, not guessed.

const OVERPASS_URL =
  process.env.OVERPASS_URL || "https://overpass.kumi.systems/api/interpreter";
const OVERPASS_TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS || 15000);
const OVERPASS_USER_AGENT =
  process.env.OVERPASS_USER_AGENT ||
  "VoltRoute-EV-Locator/1.0 (Bengaluru EV charging map; contact: admin@localhost)";
const LIVE_TTL_MS = Number(process.env.LIVE_STATION_CACHE_TTL_MS || 300000);
const OCM_API_KEY = process.env.OCM_API_KEY || "";
const OCM_BASE_URL =
  process.env.OCM_BASE_URL || "https://api.openchargemap.io/v3/poi";
const OCM_TIMEOUT_MS = Number(process.env.OCM_TIMEOUT_MS || 12000);
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
const GOOGLE_PLACES_TIMEOUT_MS = Number(process.env.GOOGLE_PLACES_TIMEOUT_MS || 12000);
const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby";

const cache = new Map(); // key -> { expires, data }

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { expires: Date.now() + LIVE_TTL_MS, data });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Overpass (OpenStreetMap) ---------------------------------------------
// Bounding-box query (uses the server spatial index — far cheaper than
// around() radius scans). Nodes AND ways/relations (with centers) so
// mapped-as-area chargers are not missed. The route layer re-filters by
// exact haversine distance afterwards.
function bboxFor(lat, lng, radiusM) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  const south = Math.max(lat - dLat, -90);
  const north = Math.min(lat + dLat, 90);
  const west = Math.max(lng - dLng, -180);
  const east = Math.min(lng + dLng, 180);
  return `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
}

function buildOverpassQuery(lat, lng, radiusM) {
  const cap = radiusM > 10000 ? 150 : 80;
  const bbox = bboxFor(lat, lng, radiusM);
  return (
    `[out:json][timeout:15];` +
    `(node["amenity"="charging"](${bbox});` +
    `way["amenity"="charging"](${bbox});` +
    `relation["amenity"="charging"](${bbox}););` +
    `out center ${cap};`
  );
}

// Normalise OSM socket tags to the connector labels the app filters on.
const SOCKET_ALIASES = {
  type2_combo: "CCS2",
  type2combo: "CCS2",
  ccs: "CCS2",
  ccs2: "CCS2",
  type2: "Type 2",
  type1: "Type 1",
  chademo: "CHAdeMO",
  tesla_supercharger: "Tesla",
  tesla_destination: "Tesla",
  gbt_dc: "GB/T DC",
  gbt_ac: "GB/T AC",
};

function normaliseConnector(raw) {
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (SOCKET_ALIASES[key]) return SOCKET_ALIASES[key];
  // Unknown socket type: keep a readable label rather than dropping it.
  return String(raw).trim();
}

function parsePowerKw(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const m = String(value).match(/[\d.]+/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildAddress(tags) {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"] || tags["addr:neighbourhood"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
    tags["addr:postcode"],
  ].filter(Boolean);
  return parts.join(", ") || "Bengaluru, Karnataka";
}

function mapOverpassElement(el) {
  const tags = el.tags || {};
  const lat = typeof el.lat === "number" ? el.lat : el.center && el.center.lat;
  const lng = typeof el.lon === "number" ? el.lon : el.center && el.center.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Collect connectors from socket tags: "socket:<type>" = yes/<count>.
  const connectors = [];
  const explicit = tags["socket:typee"] || tags.socket;
  if (explicit) {
    for (const part of String(explicit).split(/[;,]/)) {
      if (part.trim()) connectors.push(normaliseConnector(part));
    }
  }
  for (const k of Object.keys(tags)) {
    if (!k.startsWith("socket:")) continue;
    const rest = k.slice("socket:".length);
    if (!rest || rest.includes(":") || rest === "typee") continue; // e.g. socket:type2:output handled below
    const v = String(tags[k]).toLowerCase();
    if (v === "yes" || (Number(v) > 0 && String(Number(v)) === v)) {
      connectors.push(normaliseConnector(rest));
    }
  }

  // Power: prefer per-socket output, else site capacity. Missing => omitted.
  let powerKw;
  for (const k of Object.keys(tags)) {
    if (k.startsWith("socket:") && k.endsWith(":output")) {
      const p = parsePowerKw(tags[k]);
      if (p !== undefined) powerKw = Math.max(powerKw || 0, p);
    }
  }
  if (powerKw === undefined) {
    powerKw =
      parsePowerKw(tags["capacity:charging"]) ?? parsePowerKw(tags.capacity);
  }

  const station = {
    id: `osm-${el.type}-${el.id}`,
    sourceId: `${el.type}/${el.id}`,
    name: tags.name || "EV Charging Station (OSM)",
    lat,
    lng,
    address: buildAddress(tags),
    operator: tags.operator || undefined, // omitted when unknown — never invented
    connectors: [...new Set(connectors)].slice(0, 6),
    source: "openstreetmap",
  };
  if (powerKw !== undefined) station.powerKw = powerKw;
  if (el.timestamp) station.updatedAt = el.timestamp; // OSM last-edit time, when available
  return station;
}

function dedupStations(stations) {
  const seen = new Set();
  const out = [];
  for (const s of stations) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const key =
      `${s.lat.toFixed(4)},${s.lng.toFixed(4)}|` +
      `${(s.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function liveFromOverpass(lat, lng, radiusKm) {
  const key = `osm:${lat.toFixed(4)},${lng.toFixed(4)},${radiusKm}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const radiusM = Math.min(Math.round(radiusKm * 1000), 25000);
  // Form-encoded POST: some Overpass instances reject other content types.
  const body = "data=" + encodeURIComponent(buildOverpassQuery(lat, lng, radiusM));
  const res = await fetchWithTimeout(
    OVERPASS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OVERPASS_USER_AGENT,
      },
      body,
    },
    OVERPASS_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
  const json = await res.json();
  const data = dedupStations(
    (json.elements || []).map(mapOverpassElement).filter(Boolean)
  );
  cacheSet(key, data);
  return data;
}

// --- Google Places (optional, server-side key required) --------------------
// Nearby Search's EV charging-station type gives reliable, real place
// coordinates. We intentionally request only the fields needed for map pins so
// the frontend never receives the key and the request stays narrowly scoped.
async function liveFromGooglePlaces(lat, lng, radiusKm) {
  if (!GOOGLE_PLACES_API_KEY) return [];
  const cacheKey = `google:${lat.toFixed(4)},${lng.toFixed(4)},${radiusKm}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const res = await fetchWithTimeout(
    GOOGLE_PLACES_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({
        includedTypes: ["electric_vehicle_charging_station"],
        maxResultCount: 20,
        rankPreference: "DISTANCE",
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(Math.round(radiusKm * 1000), 50000),
          },
        },
      }),
    },
    GOOGLE_PLACES_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Google Places responded ${res.status}`);
  const json = await res.json();
  const data = dedupStations(
    (json.places || []).map((place) => {
      const plat = place.location?.latitude;
      const plng = place.location?.longitude;
      if (!place.id || !Number.isFinite(plat) || !Number.isFinite(plng)) return null;
      return {
        id: `google-${place.id}`,
        sourceId: `places/${place.id}`,
        name: place.displayName?.text || "EV Charging Station (Google)",
        lat: plat,
        lng: plng,
        address: place.formattedAddress || "Address unavailable",
        connectors: [], // Connector data requires a higher-cost Places field; do not infer it.
        source: "googleplaces",
      };
    }).filter(Boolean)
  );
  cacheSet(cacheKey, data);
  return data;
}

// --- OpenChargeMap (optional, key required) --------------------------------
async function liveFromOCM(lat, lng, radiusKm) {
  if (!OCM_API_KEY) return [];
  const cacheKey = `ocm:${lat.toFixed(4)},${lng.toFixed(4)},${radiusKm}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const url =
    `${OCM_BASE_URL}/?output=json&latitude=${lat}&longitude=${lng}` +
    `&distance=${radiusKm}&distanceunit=KM&maxresults=60&compact=true&verbose=false`;
  const res = await fetchWithTimeout(
    url,
    { headers: { "X-API-Key": OCM_API_KEY } },
    OCM_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`OpenChargeMap responded ${res.status}`);
  const json = await res.json();
  const data = dedupStations(
    (Array.isArray(json) ? json : [])
      .map((poi) => {
        const plat = poi.AddressInfo?.Latitude;
        const plng = poi.AddressInfo?.Longitude;
        if (!Number.isFinite(plat) || !Number.isFinite(plng)) return null;
        const conns = (poi.Connections || []).filter(
          (c) => c && c.ConnectionType && c.ConnectionType.Title
        );
        const powers = conns
          .map((c) => Number(c.PowerKW))
          .filter((n) => Number.isFinite(n) && n > 0);
        const st = {
          id: `ocm-${poi.ID}`,
          sourceId: `ocm/${poi.ID}`,
          name: poi.AddressInfo?.Title || "EV Charging Station (OCM)",
          lat: plat,
          lng: plng,
          address:
            [
              poi.AddressInfo?.AddressLine1,
              poi.AddressInfo?.Town,
              poi.AddressInfo?.Postcode,
            ]
              .filter(Boolean)
              .join(", ") || "Bengaluru, Karnataka",
          operator: poi.OperatorInfo?.Title || undefined,
          connectors: [...new Set(conns.map((c) => c.ConnectionType.Title))].slice(0, 6),
          source: "openchargemap",
        };
        if (powers.length) st.powerKw = Math.max(...powers);
        if (poi.DateLastStatusUpdate) st.updatedAt = poi.DateLastStatusUpdate;
        return st;
      })
      .filter(Boolean)
  );
  cacheSet(cacheKey, data);
  return data;
}

// Shared station data: deduped union of every live set currently cached.
// Lets search/details resolve live stations the map already showed,
// so all features use the same normalized representation.
function getCachedLiveStations() {
  const all = [];
  for (const entry of cache.values()) {
    if (entry && entry.expires > Date.now() && Array.isArray(entry.data)) {
      all.push(...entry.data);
    }
  }
  return dedupStations(all);
}

// Preferred live pipeline: Google Places when configured, then OCM, then OSM.
// Returns { stations, provider }. Throws on upstream failure.
async function getLiveStations(lat, lng, radiusKm, source) {
  if (source === "google") {
    if (!GOOGLE_PLACES_API_KEY) {
      const err = new Error("Google Places source requested but GOOGLE_PLACES_API_KEY is not configured.");
      err.status = 400;
      throw err;
    }
    return { stations: await liveFromGooglePlaces(lat, lng, radiusKm), provider: "googleplaces" };
  }
  if (source === "ocm") {
    if (!OCM_API_KEY) {
      const err = new Error("OpenChargeMap source requested but OCM_API_KEY is not configured.");
      err.status = 400;
      throw err;
    }
    return { stations: await liveFromOCM(lat, lng, radiusKm), provider: "openchargemap" };
  }
  if (source === "osm") {
    return { stations: await liveFromOverpass(lat, lng, radiusKm), provider: "openstreetmap" };
  }
  if (GOOGLE_PLACES_API_KEY) {
    const google = await liveFromGooglePlaces(lat, lng, radiusKm);
    if (google.length) return { stations: google, provider: "googleplaces" };
  }
  if (OCM_API_KEY) {
    const ocm = await liveFromOCM(lat, lng, radiusKm);
    if (ocm.length) return { stations: ocm, provider: "openchargemap" };
  }
  return { stations: await liveFromOverpass(lat, lng, radiusKm), provider: "openstreetmap" };
}

module.exports = {
  liveFromOverpass,
  liveFromGooglePlaces,
  liveFromOCM,
  getLiveStations,
  getCachedLiveStations,
  dedupStations,
};
