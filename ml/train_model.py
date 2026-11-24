"""Train a small NumPy feed-forward network for EV station suitability."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "data" / "synthetic_ev_scenarios.csv"
MODEL = ROOT / "model" / "ev_suitability_model.json"
FEATURES = [
    "distanceKm", "estimatedDriveMin", "trafficPct", "compatible",
    "usablePowerKw", "crowdPct", "estimatedWaitMin", "availabilityRatio",
    "pricePerKwh", "batteryPct", "rating", "priorityFastest",
    "priorityCheapest", "priorityShortest",
]
RNG = np.random.default_rng(20260922)


def relu(values: np.ndarray) -> np.ndarray:
    return np.maximum(values, 0)


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(values, -40, 40)))


def load_data() -> tuple[np.ndarray, np.ndarray]:
    with DATASET.open(encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    x = np.array([[float(row[name]) for name in FEATURES] for row in rows], dtype=np.float64)
    y = np.array([float(row["suitabilityScore"]) / 100 for row in rows], dtype=np.float64).reshape(-1, 1)
    return x, y


def main() -> None:
    if not DATASET.exists():
        raise SystemExit("Dataset not found. Run generate_dataset.py first.")
    x, y = load_data()
    permutation = RNG.permutation(len(x))
    cut = int(len(x) * 0.8)
    train_idx, validation_idx = permutation[:cut], permutation[cut:]
    x_train, x_valid = x[train_idx], x[validation_idx]
    y_train, y_valid = y[train_idx], y[validation_idx]
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std[std == 0] = 1
    x_train = (x_train - mean) / std
    x_valid = (x_valid - mean) / std

    # 14 inputs -> 24 ReLU -> 12 ReLU -> sigmoid score (0..100).
    w1 = RNG.normal(0, np.sqrt(2 / len(FEATURES)), (len(FEATURES), 24))
    b1 = np.zeros((1, 24))
    w2 = RNG.normal(0, np.sqrt(2 / 24), (24, 12))
    b2 = np.zeros((1, 12))
    w3 = RNG.normal(0, np.sqrt(1 / 12), (12, 1))
    b3 = np.zeros((1, 1))
    learning_rate = 0.012
    batch_size = 256
    epochs = 220

    for epoch in range(epochs):
        order = RNG.permutation(len(x_train))
        for start in range(0, len(x_train), batch_size):
            batch = order[start:start + batch_size]
            xb = x_train[batch]
            yb = y_train[batch]
            z1 = xb @ w1 + b1
            a1 = relu(z1)
            z2 = a1 @ w2 + b2
            a2 = relu(z2)
            z3 = a2 @ w3 + b3
            pred = sigmoid(z3)
            grad_z3 = 2 * (pred - yb) * pred * (1 - pred) / len(xb)
            grad_w3, grad_b3 = a2.T @ grad_z3, grad_z3.sum(axis=0, keepdims=True)
            grad_a2 = grad_z3 @ w3.T
            grad_z2 = grad_a2 * (z2 > 0)
            grad_w2, grad_b2 = a1.T @ grad_z2, grad_z2.sum(axis=0, keepdims=True)
            grad_a1 = grad_z2 @ w2.T
            grad_z1 = grad_a1 * (z1 > 0)
            grad_w1, grad_b1 = xb.T @ grad_z1, grad_z1.sum(axis=0, keepdims=True)
            w3 -= learning_rate * grad_w3; b3 -= learning_rate * grad_b3
            w2 -= learning_rate * grad_w2; b2 -= learning_rate * grad_b2
            w1 -= learning_rate * grad_w1; b1 -= learning_rate * grad_b1
        if (epoch + 1) % 50 == 0:
            valid_pred = sigmoid(relu(relu(x_valid @ w1 + b1) @ w2 + b2) @ w3 + b3)
            rmse = np.sqrt(np.mean((valid_pred - y_valid) ** 2)) * 100
            print(f"epoch {epoch + 1}: validation RMSE {rmse:.2f}")

    valid_pred = sigmoid(relu(relu(x_valid @ w1 + b1) @ w2 + b2) @ w3 + b3)
    rmse = float(np.sqrt(np.mean((valid_pred - y_valid) ** 2)) * 100)
    model = {
        "modelType": "numpy-feed-forward-regression",
        "version": "1.0.0-synthetic",
        "trainingData": "synthetic_ev_scenarios.csv (20,000 simulated scenarios)",
        "features": FEATURES,
        "mean": mean.tolist(), "std": std.tolist(),
        "layers": [{"weights": w1.tolist(), "bias": b1.tolist()}, {"weights": w2.tolist(), "bias": b2.tolist()}, {"weights": w3.tolist(), "bias": b3.tolist()}],
        "metrics": {"validationRmse": round(rmse, 3)},
        "notice": "Trained on simulated data for an academic prototype. Not a production prediction model.",
    }
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    MODEL.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
    print(f"Saved model to {MODEL}; validation RMSE {rmse:.2f}/100")


if __name__ == "__main__":
    main()
