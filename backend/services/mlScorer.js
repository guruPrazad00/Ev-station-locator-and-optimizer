"use strict";

const { spawn } = require("child_process");
const path = require("path");

const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PREDICT_SCRIPT = path.join(__dirname, "..", "..", "ml", "predict.py");

// Must match FEATURES in ml/train_model.py (predict.py reads the same order
// from the saved model). Validated here so bad rows fail fast with a 400
// instead of crashing the Python process into a generic 500.
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

function scoreCandidates(candidates) {
  return new Promise((resolve, reject) => {
    try {
      validateCandidates(candidates);
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn(PYTHON_BIN, [PREDICT_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => reject(new Error("ML scorer could not start. Set PYTHON_BIN to a Python installation with NumPy.")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ML scorer failed${stderr ? `: ${stderr.trim()}` : ""}`));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.scores) || result.scores.length !== candidates.length) {
          throw new Error("ML scorer returned an invalid score set.");
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(JSON.stringify({ candidates }));
  });
}

module.exports = { scoreCandidates };
