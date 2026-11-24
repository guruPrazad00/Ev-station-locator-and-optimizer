"use strict";

// TomTom traffic-flow tile proxy. The API key stays server-side: the browser
// only ever requests /api/traffic-tile/{z}/{x}/{y} from this backend.
// Without TOMTOM_API_KEY the route reports itself disabled (404 JSON) and the
// frontend hides the Traffic toggle.

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY || "";
const TOMTOM_TIMEOUT_MS = Number(process.env.TOMTOM_TIMEOUT_MS || 10000);
const TILE_TTL_MS = 3 * 60 * 1000;
const TILE_CACHE_MAX = 400;

const express = require("express");

const tileCache = new Map(); // "z/x/y" -> { expires, buffer }

function tileCacheGet(key) {
  const hit = tileCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.buffer;
  tileCache.delete(key);
  return null;
}

function tileCacheSet(key, buffer) {
  tileCache.set(key, { expires: Date.now() + TILE_TTL_MS, buffer });
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
}

function parseTile(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

const router = express.Router();

// GET /api/traffic-tile/:z/:x/:y → image/png
router.get("/:z/:x/:y", async (req, res, next) => {
  try {
    if (!TOMTOM_API_KEY) {
      return res.status(404).json({ error: "Traffic overlay is not configured.", disabled: true });
    }
    const z = parseTile(req.params.z, 0, 22);
    const limit = z === null ? 0 : 2 ** z - 1;
    const x = parseTile(req.params.x, 0, Math.max(limit, 0));
    const y = parseTile(req.params.y, 0, Math.max(limit, 0));
    if (z === null || x === null || y === null) {
      return res.status(400).json({ error: "Tile coordinates must satisfy z 0..22, x/y within the zoom grid." });
    }
    const key = `${z}/${x}/${y}`;
    const cached = tileCacheGet(key);
    if (cached) {
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=120");
      return res.send(cached);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOMTOM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(
        `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${encodeURIComponent(TOMTOM_API_KEY)}`,
        { signal: ctrl.signal }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) {
      // Blank tile keeps the map usable instead of showing broken-tile icons.
      return res.status(204).end();
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    tileCacheSet(key, buffer);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=120");
    res.send(buffer);
  } catch (err) {
    // Tile failures must never break the map: log server-side, send blank.
    console.error("Traffic tile error:", err.message);
    res.status(204).end();
  }
});

module.exports = router;
module.exports.trafficOverlayEnabled = () => Boolean(TOMTOM_API_KEY);
