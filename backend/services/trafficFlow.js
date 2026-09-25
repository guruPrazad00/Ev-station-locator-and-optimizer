"use strict";

// Live road-traffic congestion via TomTom Flow Segment Data, mapped onto the
// ML model's trafficPct feature (percent slower than free-flow, 5..95 to stay
// inside the training distribution). Key stays server-side; results cached
// briefly because flow changes slowly relative to request volume.
// Anything missing, low-confidence, or failed falls back to simulated values
// in the caller — this module only reports live readings or null.

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_TIMEOUT_MS = Number(process.env.TOMTOM_TIMEOUT_MS || 10000);
const FLOW_ZOOM = 10; // city-segment granularity
const MIN_CONFIDENCE = 0.5;
const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_CACHE_MAX = 500;

const flowCache = new Map(); // "lat,lng" (3dp) -> { expires, seg: {current, free} }

function flowCacheGet(key) {
  const hit = flowCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.seg;
  flowCache.delete(key);
  return null;
}

function flowCacheSet(key, seg) {
  flowCache.set(key, { expires: Date.now() + FLOW_TTL_MS, seg });
  if (flowCache.size > FLOW_CACHE_MAX) flowCache.delete(flowCache.keys().next().value);
}

function toTrafficPct(currentSpeed, freeFlowSpeed) {
  if (!Number.isFinite(currentSpeed) || !Number.isFinite(freeFlowSpeed) || freeFlowSpeed <= 0) {
    return null;
  }
  const pct = Math.round((1 - currentSpeed / freeFlowSpeed) * 100);
  return Math.min(95, Math.max(5, pct));
}

// Raw segment speeds, cached. Null when unavailable/unusable.
async function getFlowSegment(lat, lng) {
  if (!TOMTOM_API_KEY) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = flowCacheGet(key);
  if (cached) return cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOMTOM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/${FLOW_ZOOM}/json` +
        `?point=${lat},${lng}&key=${encodeURIComponent(TOMTOM_API_KEY)}`,
      { signal: ctrl.signal }
    );
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);
  if (!res.ok) return null;
  let json;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  const seg = json && json.flowSegmentData;
  if (!seg || seg.roadClosure) return null; // closures need routing, not a ratio
  if (Number(seg.confidence) < MIN_CONFIDENCE) return null;
  const current = Number(seg.currentSpeed);
  const free = Number(seg.freeFlowSpeed);
  if (!Number.isFinite(current) || !Number.isFinite(free) || free <= 0 || current <= 0) return null;
  const out = { current, free };
  flowCacheSet(key, out);
  return out;
}

// Returns { trafficPct, mode: "live" } or null when live data is unavailable.
async function liveTrafficPct(lat, lng) {
  const seg = await getFlowSegment(lat, lng);
  if (!seg) return null;
  const pct = toTrafficPct(seg.current, seg.free);
  if (pct === null) return null;
  return { trafficPct: pct, mode: "live" };
}

const ROUTE_SAMPLES = 6;
const DEFAULT_CRUISE_KMH = 50; // economy riding band (40–60 km/h)

// Traffic-aware ETA for a road route. Samples live speeds along the geometry
// and integrates time as distance × mean(1/effectiveSpeed) — i.e. the harmonic
// mean speed, capped at the rider's cruise speed so free-flow freeways don't
// inflate the estimate beyond economy pace. Returns null when unusable.
async function routeTrafficEta(distanceKm, coordinates, cruiseKmh) {
  if (!TOMTOM_API_KEY) return null;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const cruise = Number.isFinite(cruiseKmh) && cruiseKmh >= 20 && cruiseKmh <= 80
    ? cruiseKmh
    : DEFAULT_CRUISE_KMH;
  const step = Math.max(1, Math.floor(coordinates.length / ROUTE_SAMPLES));
  const sampled = [];
  for (let i = 0; i < coordinates.length && sampled.length < ROUTE_SAMPLES; i += step) {
    sampled.push(coordinates[i]);
  }
  if (sampled.length < 2) sampled.push(coordinates[coordinates.length - 1]);
  const segs = await Promise.all(
    sampled.map(([lng, lat]) => getFlowSegment(lat, lng))
  );
  const valid = segs.filter(Boolean);
  if (!valid.length) return null;
  let invSum = 0;
  let congSum = 0;
  for (const seg of valid) {
    const effective = Math.min(seg.current, cruise);
    invSum += 1 / effective;
    congSum += Math.min(95, Math.max(0, Math.round((1 - seg.current / seg.free) * 100)));
  }
  const durationMin = Math.round((distanceKm * (invSum / valid.length) * 60) * 10) / 10;
  return {
    trafficPct: Math.round(congSum / valid.length),
    durationMin,
    samples: valid.length,
    cruiseKmh: cruise,
  };
}

module.exports = { liveTrafficPct, routeTrafficEta, trafficFlowEnabled: () => Boolean(TOMTOM_API_KEY) };
