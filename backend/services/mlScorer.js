"use strict";

// ML scorer — tries the Python predictor (ml/predict.py) first when a Python
// interpreter with NumPy is available; falls back to the Node.js port
// (ml/predict.js) on hosts like Vercel where Python is not available.
// Either way, the same trained model (ml/model/ev_suitability_model.json) is
// used, so scores are identical.

const { spawn } = require("child_process");
const path = require("path");
const { scoreCandidates: scoreNode } = require("../../ml/predict");

const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PREDICT_SCRIPT = path.join(__dirname, "..", "..", "ml", "predict.py");

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

// Try the Python predictor via subprocess. Returns null if Python/NumPy is
// unavailable or the call fails — caller falls back to Node.js.
function scoreWithPython(candidates) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [PREDICT_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => reject(new Error("python unavailable")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`python exited ${code}: ${stderr.trim()}`));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.scores) || result.scores.length !== candidates.length) {
          return reject(new Error("python returned invalid score set"));
        }
        resolve({ scores: result.scores, modelVersion: result.modelVersion });
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(JSON.stringify({ candidates }));
  });
}

function scoreCandidatesWrapper(candidates) {
  validateCandidates(candidates);

  // Prefer Python when available; fall back to Node.js port.
  return scoreWithPython(candidates).catch((pythonErr) => {
    console.log("Python scorer unavailable, using Node.js port:", pythonErr.message);
    const result = scoreNode(candidates);
    if (!Array.isArray(result.scores) || result.scores.length !== candidates.length) {
      throw new Error("ML scorer returned an invalid score set.");
    }
    return { scores: result.scores, modelVersion: result.modelVersion };
  });
}

module.exports = { scoreCandidates: scoreCandidatesWrapper };
