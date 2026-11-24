"use strict";

const express = require("express");
const { getRoute } = require("../services/router");
const { validateRoute } = require("../middleware/validate");

const router = express.Router();

// GET /api/route?fromLat=&fromLng=&toLat=&toLng=[&cruiseKmh=]
// cruiseKmh (20..80, default 50) caps effective speeds at economy pace.
router.get("/", async (req, res, next) => {
  try {
    const parsed = validateRoute(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    let cruiseKmh = 50;
    if (req.query.cruiseKmh !== undefined && req.query.cruiseKmh !== "") {
      const c = Number(req.query.cruiseKmh);
      if (!Number.isFinite(c) || c < 20 || c > 80) {
        return res.status(400).json({ error: "cruiseKmh must be a number between 20 and 80." });
      }
      cruiseKmh = c;
    }
    const result = await getRoute(parsed.fromLat, parsed.fromLng, parsed.toLat, parsed.toLng, cruiseKmh);
    res.json({ ...result, profile: "driving", provider: "osrm" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
