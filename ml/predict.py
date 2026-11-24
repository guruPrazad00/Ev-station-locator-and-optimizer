"""Read candidate feature rows from stdin and emit neural-network scores."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

MODEL = Path(__file__).resolve().parent / "model" / "ev_suitability_model.json"


def relu(values: np.ndarray) -> np.ndarray:
    return np.maximum(values, 0)


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(values, -40, 40)))


def main() -> None:
    request = json.load(sys.stdin)
    model = json.loads(MODEL.read_text(encoding="utf-8"))
    features = model["features"]
    rows = request.get("candidates", [])
    x = np.array([[float(row[name]) for name in features] for row in rows], dtype=np.float64)
    if not len(x):
        print(json.dumps({"scores": [], "modelVersion": model["version"]}))
        return
    x = (x - np.array(model["mean"])) / np.array(model["std"])
    layers = model["layers"]
    a1 = relu(x @ np.array(layers[0]["weights"]) + np.array(layers[0]["bias"]))
    a2 = relu(a1 @ np.array(layers[1]["weights"]) + np.array(layers[1]["bias"]))
    scores = sigmoid(a2 @ np.array(layers[2]["weights"]) + np.array(layers[2]["bias"])) * 100
    print(json.dumps({"scores": [round(float(score[0]), 1) for score in scores], "modelVersion": model["version"]}))


if __name__ == "__main__":
    main()
