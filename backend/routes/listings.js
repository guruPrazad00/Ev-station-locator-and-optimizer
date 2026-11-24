"use strict";

const express = require("express");
const { authRequired, roleRequired } = require("../middleware/auth");
const { CONNECTORS, getOwnerListings, createListing } = require("../services/listings");

const router = express.Router();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// POST /api/listings (owner role) — register a station for the map.
router.post("/", authRequired, roleRequired("owner"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    const lat = num(body.lat);
    const lng = num(body.lng ?? body.lon);
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 200) : "";
    const operator = typeof body.operator === "string" ? body.operator.trim().slice(0, 80) : "";
    const connectors = Array.isArray(body.connectors)
      ? [...new Set(body.connectors.map((c) => String(c).trim()))].filter((c) => CONNECTORS.has(c)).slice(0, 6)
      : null;
    const powerKw = body.powerKw === undefined || body.powerKw === null || body.powerKw === ""
      ? undefined
      : num(body.powerKw);
    if (!name) return res.status(400).json({ error: "Station name is required." });
    if (lat === null || lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "Valid lat (-90..90) and lng (-180..180) are required." });
    }
    if (!connectors || !connectors.length) {
      return res.status(400).json({ error: `At least one connector is required (${[...CONNECTORS].join(", ")}).` });
    }
    if (powerKw !== undefined && (powerKw <= 0 || powerKw > 1000)) {
      return res.status(400).json({ error: "powerKw must be between 0 and 1000." });
    }
    const station = await createListing(req.user.id, { name, lat, lng, address, connectors, powerKw, operator });
    res.status(201).json(station);
  } catch (err) {
    next(err);
  }
});

// GET /api/listings/mine (any authenticated user sees their own submissions)
router.get("/mine", authRequired, async (req, res, next) => {
  try {
    const stations = await getOwnerListings(req.user.id);
    res.json({ count: stations.length, stations });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
