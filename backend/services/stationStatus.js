"use strict";

// Demonstration-only operational data. Public station sources used by the
// locator do not consistently provide pricing, occupancy, or queue length.
// These deterministic values let the recommendation pipeline be built and
// tested without presenting them as live provider data.

function stableNumber(value) {
  let hash = 2166136261;
  for (const char of String(value || "station")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function simulatedStatus(station) {
  const n = stableNumber(station.id || station.sourceId || station.name);
  const totalSlots = 3 + (n % 6);
  const crowdPct = 15 + ((n >>> 3) % 76);
  const availableSlots = Math.max(0, Math.min(totalSlots, Math.round(totalSlots * (100 - crowdPct) / 100)));
  return {
    dataMode: "simulated",
    totalSlots,
    availableSlots,
    crowdPct,
    trafficPct: 10 + ((n >>> 17) % 76),
    estimatedWaitMin: availableSlots ? Math.max(0, Math.round(crowdPct / 18) - 1) : 12 + (n % 18),
    pricePerKwh: 14 + ((n >>> 9) % 8),
    rating: Math.round((3.6 + ((n >>> 15) % 14) / 10) * 10) / 10,
  };
}

module.exports = { simulatedStatus };
