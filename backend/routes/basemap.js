"use strict";

// CARTO basemap tile proxy. The API key stays server-side: the browser only
// ever requests /api/basemap-tile/{z}/{x}/{y} from this backend.
// Without CARTO_BASEMAPS_KEY the route reports itself disabled (404 JSON) and
// the frontend falls back to key-free tiles.

const CARTO_KEY = process.env.CARTO_BASEMAPS_KEY || "";
const CARTO_TIMEOUT_MS = Number(process.env.CARTO_TIMEOUT_MS || 10000);
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_CACHE_MAX = 300;

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

// GET /api/basemap-tile/:z/:x/:y → image/png
router.get("/:z/:x/:y", async (req, res) => {
  if (!CARTO_KEY) {
    return res.status(404).json({ error: "Basemap proxy is not configured.", disabled: true });
  }
  const z = parseTile(req.params.z, 0, 20);
  const limit = z === null ? 0 : 2 ** z - 1;
  const x = parseTile(req.params.x, 0, Math.max(limit, 0));
  const y = parseTile(req.params.y, 0, Math.max(limit, 0));
  if (z === null || x === null || y === null) {
    return res.status(400).json({ error: "Tile coordinates must satisfy z 0..20, x/y within the zoom grid." });
  }
  const key = `${z}/${x}/${y}`;
  const cached = tileCacheGet(key);
  if (cached) {
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(cached);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CARTO_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(
      `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png?key=${encodeURIComponent(CARTO_KEY)}`,
      { signal: ctrl.signal }
    );
  } catch (err) {
    clearTimeout(timer);
    console.error("Basemap tile error:", err.message);
    return res.status(204).end();
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    console.error(`Basemap tile upstream responded ${upstream.status}.`);
    return res.status(204).end();
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  tileCacheSet(key, buffer);
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(buffer);
});

module.exports = router;
module.exports.basemapEnabled = () => Boolean(CARTO_KEY);
