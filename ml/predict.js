"use strict";

// Node.js port of ml/predict.py — runs the saved NumPy feed-forward model
// (14→24→12→1) without Python, so it works on Vercel serverless.

const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "model", "ev_suitability_model.json");

function relu(values) {
  return values.map((v) => Math.max(v, 0));
}

function sigmoid(values) {
  return values.map((v) => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, v)))));
}

// Multiply a row vector (length N) by a matrix (N x M) → length M.
function matVec(row, matrix) {
  const out = new Array(matrix[0].length).fill(0);
  for (let i = 0; i < row.length; i++) {
    const ri = row[i];
    if (ri === 0) continue;
    for (let j = 0; j < matrix[0].length; j++) {
      out[j] += ri * matrix[i][j];
    }
  }
  return out;
}

function loadModel() {
  return JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));
}

function scoreCandidates(candidates) {
  const model = loadModel();
  const { features, mean, std, layers, version } = model;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { scores: [], modelVersion: version };
  }

  // Build feature matrix: rows × features
  const rows = candidates.map((row) =>
    features.map((name) => Number(row[name] || 0))
  );

  // Normalize: (x - mean) / std
  const normalized = rows.map((row) =>
    row.map((v, i) => (v - mean[i]) / std[i])
  );

  // Forward pass through layers
  let activations = normalized;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const weights = layer.weights; // [inputSize][outputSize]
    const bias = layer.bias;       // [outputSize]

    const batchOut = activations.map((act) => {
      const dot = matVec(act, weights);
      return dot.map((v, j) => v + bias[0][j]);
    });

    if (li < layers.length - 1) {
      activations = batchOut.map((row) => relu(row));
    } else {
      activations = batchOut.map((row) => sigmoid(row).map((v) => v * 100));
    }
  }

  const scores = activations.map((row) => Math.round(row[0] * 10) / 10);
  return { scores, modelVersion: version };
}

module.exports = { scoreCandidates, loadModel };
