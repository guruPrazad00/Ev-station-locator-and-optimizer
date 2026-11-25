"use strict";

const express = require("express");
const { nearbyStations, filterByConnector } = require("../services/stationSource");
const { simulatedStatus } = require("../services/stationStatus");
const { liveTrafficPct } = require("../services/trafficFlow");
const { getRoute } = require("../services/router");
const { scoreCandidates } = require("../services/mlScorer");
const { validateNearby } = require("../middleware/validate");

const router = express.Router();

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// GET /api/recommendations/candidates
// Creates an explainable feasible feature set, then passes its batch to the
// trained local neural-network regressor for suitability scoring and ranking.
router.get("/candidates", async (req, res, next) => {
  try {
  const location = validateNearby({ ...req.query, radiusKm: req.query.radiusKm || 50, limit: 100 });
  if (location.error) return res.status(400).json({ error: location.error });

  const batteryKwh = boundedNumber(req.query.batteryKwh, 40, 2, 150);
  const batteryPct = boundedNumber(req.query.batteryPct, 60, 5, 100);
  const consumptionKwhPer100Km = boundedNumber(req.query.consumptionKwhPer100Km, 15, 2, 40);
  const maxDcPowerKw = boundedNumber(req.query.maxDcPowerKw, 50, 2, 500);
  if ([batteryKwh, batteryPct, consumptionKwhPer100Km, maxDcPowerKw].some((n) => n === null)) {
    return res.status(400).json({ error: "Vehicle inputs are outside the supported prototype range." });
  }

  const connector = String(req.query.connector || "all").slice(0, 30);
  const priority = ["balanced", "fastest", "cheapest", "shortest"].includes(req.query.priority)
    ? req.query.priority
    : "balanced";
  const safetyFactor = 0.8; // Preserve 20% usable range as a demo safety reserve.
  const usableRangeKm = Math.round((batteryKwh * (batteryPct / 100) / consumptionKwhPer100Km) * 100 * safetyFactor * 10) / 10;
  const searchRadiusKm = Math.min(location.radiusKm, usableRangeKm, 50);
  const nearby = await nearbyStations({ ...location, radiusKm: searchRadiusKm, connector: "all", limit: 100 });
  const compatible = filterByConnector(nearby, connector);
  // Live TomTom congestion per candidate (cached, best-effort); anything
  // unresolved keeps its simulated value and is labelled accordingly.
  const liveTraffic = await Promise.all(
    compatible.map((station) => liveTrafficPct(station.lat, station.lng))
  );
  const candidates = compatible.map((station, index) => {
    const status = simulatedStatus(station);
    const live = liveTraffic[index];
    const trafficPct = live ? live.trafficPct : status.trafficPct;
    const usablePowerKw = Math.min(station.powerKw || maxDcPowerKw, maxDcPowerKw);
    return {
      ...station,
      ...status,
      trafficPct,
      trafficMode: live ? "live" : "simulated",
      usablePowerKw,
      reachable: station.distanceKm <= usableRangeKm,
      // estimatedDriveMin is resolved below from real road routes when possible.
      pendingDrive: { distanceKm: station.distanceKm, trafficPct },
    };
  }).filter((station) => station.reachable);

  // Real road-route ETAs as the drive-time feature: one OSRM + traffic
  // estimate per candidate (both cached). Failures keep the formula fallback.
  await Promise.all(candidates.map(async (candidate) => {
    const fallbackDrive = Math.round(candidate.pendingDrive.distanceKm * (1.1 + candidate.pendingDrive.trafficPct / 100) * 1.45 * 10) / 10;
    try {
      const route = await getRoute(location.lat, location.lng, candidate.lat, candidate.lng);
      if (route && Number.isFinite(route.durationMin)) {
        candidate.estimatedDriveMin = route.traffic && Number.isFinite(route.traffic.durationMin)
          ? route.traffic.durationMin
          : route.durationMin;
        if (route.traffic && Number.isFinite(route.traffic.trafficPct)) {
          candidate.trafficPct = route.traffic.trafficPct;
          candidate.trafficMode = "live";
        }
        candidate.routeBaselineMin = route.durationMin;
      } else {
        candidate.estimatedDriveMin = fallbackDrive;
      }
    } catch {
      candidate.estimatedDriveMin = fallbackDrive;
    }
    delete candidate.pendingDrive;
    candidate.features = {
      distanceKm: candidate.distanceKm,
      estimatedDriveMin: candidate.estimatedDriveMin,
      trafficPct: candidate.trafficPct,
      compatible: true,
      usablePowerKw: candidate.usablePowerKw,
      crowdPct: candidate.crowdPct,
      estimatedWaitMin: candidate.estimatedWaitMin,
      availabilityRatio: Math.round((candidate.availableSlots / candidate.totalSlots) * 100) / 100,
      pricePerKwh: candidate.pricePerKwh,
      batteryPct,
      rating: candidate.rating,
      priorityFastest: Number(priority === "fastest"),
      priorityCheapest: Number(priority === "cheapest"),
      priorityShortest: Number(priority === "shortest"),
    };
  }));

  let scored;
  try {
    scored = await scoreCandidates(candidates.map((candidate) => candidate.features));
  } catch (mlErr) {
    console.error("ML scorer error:", mlErr.stack);
    throw mlErr;
  }
  candidates.forEach((candidate, index) => { candidate.aiScore = scored.scores[index]; });
  candidates.sort((a, b) => b.aiScore - a.aiScore);
  const liveTrafficCount = candidates.filter((c) => c.trafficMode === "live").length;

  res.json({
    mode: "neural-network-ranking",
    dataNotice: liveTrafficCount
      ? `The neural network was trained on synthetic scenarios. Drive times come from real road routes and traffic congestion is live TomTom data (${liveTrafficCount}/${candidates.length} candidates); availability, crowd, waiting time, pricing, and rating are deterministic simulated demo data, not live station telemetry.`
      : "The neural network was trained on synthetic scenarios. Availability, crowd, traffic, waiting time, pricing, and rating are deterministic simulated demo data, not live station telemetry.",
    model: { version: scored.modelVersion, scoreLabel: "AI suitability score /100" },
    vehicle: { batteryKwh, batteryPct, consumptionKwhPer100Km, maxDcPowerKw, connector, priority },
    usableRangeKm,
    searchedRadiusKm: searchRadiusKm,
    counts: { nearby: nearby.length, compatible: compatible.length, reachable: candidates.length, liveTraffic: liveTrafficCount },
    candidates,
  });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
