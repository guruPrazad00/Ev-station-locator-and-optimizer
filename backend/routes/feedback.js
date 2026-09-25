"use strict";

// Choice-logging endpoint for future model training with observed outcomes.
// Appends one JSON object per line to a git-ignored .jsonl file. No PII:
// precise user coordinates are never accepted (stripped if sent) and no
// identifiers, accounts, or device data are recorded.

const fs = require("fs");
const path = require("path");
const express = require("express");

const LOG_FILE = process.env.FEEDBACK_LOG ||
  path.join(__dirname, "..", "..", "feedback-choices.jsonl");

const ACTIONS = new Set(["select", "directions", "good", "bad"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanFeatures(value) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 30)) {
    if (typeof key !== "string" || key.length > 40) continue;
    const num = Number(raw);
    out[key] = Number.isFinite(num) ? num : String(raw).slice(0, 80);
  }
  return out;
}

const router = express.Router();

// POST /api/feedback/choice
// { stationId, action: select|directions|good|bad, features?, aiScore?, batteryPct?, priority? }
router.post("/choice", express.json({ limit: "10kb" }), (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const stationId = typeof body.stationId === "string" ? body.stationId.trim().slice(0, 128) : "";
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!stationId) return res.status(400).json({ error: "stationId is required." });
  if (!ACTIONS.has(action)) {
    return res.status(400).json({ error: "action must be one of: select, directions, good, bad." });
  }
  const entry = {
    time: new Date().toISOString(),
    stationId,
    action,
  };
  const features = cleanFeatures(body.features);
  if (features && Object.keys(features).length) entry.features = features;
  for (const field of ["aiScore", "batteryPct"]) {
    if (body[field] !== undefined) {
      const num = Number(body[field]);
      if (!Number.isFinite(num)) return res.status(400).json({ error: `${field} must be numeric.` });
      entry[field] = num;
    }
  }
  if (body.priority !== undefined) {
    const priority = String(body.priority).slice(0, 20);
    if (!["balanced", "fastest", "cheapest", "shortest"].includes(priority)) {
      return res.status(400).json({ error: "priority value not recognised." });
    }
    entry.priority = priority;
  }
  // Never persist precise user coordinates, even if a client sends them.
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    return res.status(500).json({ error: "Could not record feedback." });
  }
  res.json({ ok: true });
});

module.exports = router;
