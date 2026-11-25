"use strict";

// ML scorer — Node.js port of ml/predict.py. Runs the saved feed-forward
// model (14→24→12→1) directly without Python, so it works on Vercel
// serverless and any Node.js host.

const path = require("path");
const { scoreCandidates } = require("../../ml/predict");

// Must match FEATURES in ml/train_model.py. Validated here so bad rows fail
// fast with a 400 instead of producing garbage scores.
const FEATURES = [
  "distanceKm", "estimatedDriveMin", "trafficPct", "compatible",
  "usablePowerKw", "crowdPct", "estimatedWaitMin", "availabilityRatio",
  "pricePerKwh", "batteryPct", "rating", "priorityFastest",
  "priorityCheapest", "priorityShortest",
];
const MAX_BATCH = 200;

function validateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    const err = new Error("Candidates must be an array of feature rows.");
    err.status = 400;
    throw err;
  }
  if (candidates.length > MAX_BATCH) {
    const err = new Error(`Candidate batch too large (max ${MAX_BATCH}).`);
    err.status = 400;
    throw err;
  }
  candidates.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      const err = new Error(`Candidate ${index} is not a feature object.`);
      err.status = 400;
      throw err;
    }
    for (const name of FEATURES) {
      if (!Number.isFinite(Number(row[name]))) {
        const err = new Error(`Candidate ${index} has an invalid feature: ${name}.`);
        err.status = 400;
        throw err;
      }
    }
  });
}

function scoreCandidatesWrapper(candidates) {
  validateCandidates(candidates);
  const result = scoreCandidates(candidates);
  if (!Array.isArray(result.scores) || result.scores.length !== candidates.length) {
    throw new Error("ML scorer returned an invalid score set.");
  }
  return { scores: result.scores, modelVersion: result.modelVersion };
}

module.exports = { scoreCandidates: scoreCandidatesWrapper };
