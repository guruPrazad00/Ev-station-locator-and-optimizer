"use strict";

function isLat(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
}

function isLng(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
}

function num(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function validateNearby(query) {
  const lat = num(query.lat);
  const lng = num(query.lng ?? query.lon);
  if (!isLat(lat) || !isLng(lng)) {
    return { error: "Query needs numeric lat (-90..90) and lng (-180..180)." };
  }
  let radiusKm = query.radiusKm ?? query.radius ?? 10;
  radiusKm = Number(radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50) {
    return { error: "radiusKm must be a number between 0 and 50." };
  }
  let limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return { error: "limit must be between 1 and 100." };
  }
  return { lat, lng, radiusKm, limit: Math.floor(limit) };
}

function validateRoute(query) {
  const fromLat = num(query.fromLat);
  const fromLng = num(query.fromLng ?? query.fromLon);
  const toLat = num(query.toLat);
  const toLng = num(query.toLng ?? query.toLon);
  if (!isLat(fromLat) || !isLng(fromLng) || !isLat(toLat) || !isLng(toLng)) {
    return {
      error:
        "Query needs numeric fromLat, fromLng, toLat, toLng (lat -90..90, lng -180..180).",
    };
  }
  return { fromLat, fromLng, toLat, toLng };
}

module.exports = { validateNearby, validateRoute };
