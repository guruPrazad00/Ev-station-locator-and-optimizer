"use strict";

// OSRM routing proxy. Uses the free public OSRM demo server by default
// (no API key). Returns distance + baseline duration + GeoJSON geometry,
// plus a traffic-aware ETA when a TomTom key is configured.

const { routeTrafficEta } = require("./trafficFlow");

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL ||
  "https://router.project-osrm.org/route/v1/driving";
const OSRM_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS || 12000);

// Short-lived cache: repeated selections of the same station must not
// re-hit the upstream router. Key rounds coords to ~10 m precision.
const routeCache = new Map();
const ROUTE_TTL_MS = 5 * 60 * 1000;

function cacheKey(fromLat, fromLng, toLat, toLng, cruiseKmh) {
  const r = (n) => Number(n).toFixed(4);
  return `${r(fromLat)},${r(fromLng)}>${r(toLat)},${r(toLng)}@${cruiseKmh}`;
}

async function getRoute(fromLat, fromLng, toLat, toLng, cruiseKmh) {
  const cruise = Number.isFinite(Number(cruiseKmh)) ? Number(cruiseKmh) : 50;
  const key = cacheKey(fromLat, fromLng, toLat, toLng, cruise);
  const hit = routeCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  const url =
    `${OSRM_BASE_URL}/${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=full&geometries=geojson&steps=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Routing provider responded with ${res.status}`);
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes || !json.routes.length) {
    const err = new Error(json.message || "No route found between these points");
    err.status = 404;
    throw err;
  }
  const best = json.routes[0];
  const distanceKm = Math.round((best.distance / 1000) * 100) / 100;
  const result = {
    distanceM: Math.round(best.distance),
    distanceKm,
    durationS: Math.round(best.duration),
    durationMin: Math.round((best.duration / 60) * 10) / 10,
    geometry: best.geometry, // GeoJSON LineString
    // durationMin is the OSRM baseline (no traffic). traffic carries the
    // live-traffic ETA (null without a TomTom key or usable samples).
    traffic: best.geometry && best.geometry.coordinates
      ? await routeTrafficEta(distanceKm, best.geometry.coordinates, cruise).catch(() => null)
      : null,
  };
  routeCache.set(key, { expires: Date.now() + ROUTE_TTL_MS, data: result });
  if (routeCache.size > 200) routeCache.delete(routeCache.keys().next().value);
  return result;
}

module.exports = { getRoute };
