"use strict";

const express = require("express");
const { authRequired, roleRequired } = require("../middleware/auth");
const { CONNECTORS, getOwnerListings, createListing } = require("../services/listings");
const { initDb } = require("../db");

const router = express.Router();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bengaluru service area bounds (generous fringe allowance).
const BLR_BOUNDS = { minLat: 12.4, maxLat: 13.6, minLng: 77.0, maxLng: 78.1 };

const OPERATIONAL_STATUSES = new Set(["operational", "maintenance", "offline"]);

// POST /api/listings (owner role) — register a station for the map.
router.post("/", authRequired, roleRequired("owner"), async (req, res, next) => {
  try {
    await initDb();
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
    const chargingPoints = body.chargingPoints === undefined || body.chargingPoints === null || body.chargingPoints === ""
      ? undefined
      : num(body.chargingPoints);
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 30) : "";
    const city = typeof body.city === "string" ? body.city.trim().slice(0, 80) || "Bengaluru" : "Bengaluru";
    const state = typeof body.state === "string" ? body.state.trim().slice(0, 80) || "Karnataka" : "Karnataka";
    const postalCode = typeof body.postalCode === "string" ? body.postalCode.trim().slice(0, 20) : "";
    const tariff = typeof body.tariff === "string" ? body.tariff.trim().slice(0, 80) : "";
    const openingHours = typeof body.openingHours === "string" ? body.openingHours.trim().slice(0, 120) : "";
    const operationalStatus = typeof body.operationalStatus === "string" ? body.operationalStatus.trim().slice(0, 30) || "operational" : "operational";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim().slice(0, 500) : "";

    if (!name) return res.status(400).json({ error: "Station name is required." });
    if (lat === null || lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "Valid lat (-90..90) and lng (-180..180) are required." });
    }
    if (lat < BLR_BOUNDS.minLat || lat > BLR_BOUNDS.maxLat || lng < BLR_BOUNDS.minLng || lng > BLR_BOUNDS.maxLng) {
      return res.status(400).json({ error: "Coordinates must be inside the Bengaluru service area." });
    }
    if (!connectors || !connectors.length) {
      return res.status(400).json({ error: `At least one connector is required (${[...CONNECTORS].join(", ")}).` });
    }
    if (powerKw !== undefined && (powerKw <= 0 || powerKw > 1000)) {
      return res.status(400).json({ error: "powerKw must be between 0 and 1000." });
    }
    if (chargingPoints !== undefined && (!Number.isInteger(chargingPoints) || chargingPoints < 1 || chargingPoints > 200)) {
      return res.status(400).json({ error: "chargingPoints must be a whole number between 1 and 200." });
    }
    if (phone && !/^[0-9+\-()\s]{6,20}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }
    if (postalCode && !/^[1-9][0-9]{5}$/.test(postalCode)) {
      return res.status(400).json({ error: "PIN code must be 6 digits." });
    }
    if (!OPERATIONAL_STATUSES.has(operationalStatus)) {
      return res.status(400).json({ error: "operationalStatus must be operational, maintenance, or offline." });
    }
    if (imageUrl && !/^https?:\/\/[^\s]+$/i.test(imageUrl)) {
      return res.status(400).json({ error: "imageUrl must start with http:// or https://." });
    }

    const station = await createListing(req.user.id, {
      name, lat, lng, address, operator, connectors,
      powerKw, chargingPoints, phone, city, state, postalCode,
      tariff, openingHours, operationalStatus, imageUrl,
    });
    res.status(201).json(station);
  } catch (err) {
    next(err);
  }
});

// GET /api/listings/mine (any authenticated user sees their own submissions)
router.get("/mine", authRequired, async (req, res, next) => {
  try {
    await initDb();
    const stations = await getOwnerListings(req.user.id);
    res.json({ count: stations.length, stations });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
