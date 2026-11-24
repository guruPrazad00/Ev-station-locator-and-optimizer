"""Create reproducible, synthetic EV charging recommendation scenarios.

This file deliberately models plausible relationships for a university prototype;
it is not collected station telemetry. The generated label is a synthetic user
preference outcome used to train the neural-network suitability regressor.
"""

from __future__ import annotations

import csv
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "data" / "synthetic_ev_scenarios.csv"
SEED = 20260922
ROWS = 20000

FEATURES = [
    "distanceKm", "estimatedDriveMin", "trafficPct", "compatible",
    "usablePowerKw", "crowdPct", "estimatedWaitMin", "availabilityRatio",
    "pricePerKwh", "batteryPct", "rating", "priorityFastest",
    "priorityCheapest", "priorityShortest",
]


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def preference_weights(priority: str) -> dict[str, float]:
    if priority == "fastest":
        return {"drive": 0.23, "power": 0.25, "wait": 0.25, "price": 0.05, "availability": 0.12, "rating": 0.03, "crowd": 0.07}
    if priority == "cheapest":
        return {"drive": 0.14, "power": 0.08, "wait": 0.15, "price": 0.34, "availability": 0.14, "rating": 0.05, "crowd": 0.10}
    if priority == "shortest":
        return {"drive": 0.40, "power": 0.12, "wait": 0.16, "price": 0.09, "availability": 0.12, "rating": 0.03, "crowd": 0.08}
    return {"drive": 0.22, "power": 0.16, "wait": 0.18, "price": 0.16, "availability": 0.14, "rating": 0.06, "crowd": 0.08}


def make_row(rng: random.Random) -> dict[str, float]:
    priority = rng.choice(["balanced", "fastest", "cheapest", "shortest"])
    distance = round(rng.uniform(0.3, 45), 2)
    traffic = round(rng.uniform(5, 95), 1)
    drive = round(distance * (1.15 + traffic / 100) * rng.uniform(1.1, 1.9), 1)
    compatible = 1 if rng.random() > 0.14 else 0
    power = round(rng.choice([3.3, 7.2, 25, 50, 60, 120, 150]) * rng.uniform(0.9, 1.05), 1)
    crowd = round(rng.uniform(5, 98), 1)
    availability = round(clamp(1 - crowd / 100 + rng.uniform(-0.18, 0.18), 0, 1), 2)
    wait = round(max(0, crowd * (1 - availability) / 7 + rng.uniform(-3, 5)), 1)
    price = round(rng.uniform(12, 28), 2)
    battery = round(rng.uniform(10, 100), 1)
    rating = round(rng.uniform(3.2, 5.0), 1)
    weights = preference_weights(priority)

    drive_score = clamp(1 - drive / 95) 
    power_score = clamp(power / 150)
    wait_score = clamp(1 - wait / 40)
    price_score = clamp(1 - (price - 12) / 16)
    availability_score = availability
    rating_score = clamp((rating - 3) / 2)
    crowd_score = clamp(1 - crowd / 100)
    score = 100 * (
        weights["drive"] * drive_score + weights["power"] * power_score +
        weights["wait"] * wait_score + weights["price"] * price_score +
        weights["availability"] * availability_score + weights["rating"] * rating_score +
        weights["crowd"] * crowd_score
    )
    # Incompatibility is a hard constraint; it must never receive a useful score.
    if not compatible:
        score = rng.uniform(0, 12)
    else:
        # A low battery makes a long detour less suitable even before hard
        # reachability filtering, and noise prevents a perfectly formulaic label.
        score -= max(0, (distance - battery * 0.55) * 1.1)
        score += rng.gauss(0, 2.2)

    return {
        "distanceKm": distance, "estimatedDriveMin": drive, "trafficPct": traffic,
        "compatible": compatible, "usablePowerKw": power, "crowdPct": crowd,
        "estimatedWaitMin": wait, "availabilityRatio": availability,
        "pricePerKwh": price, "batteryPct": battery, "rating": rating,
        "priorityFastest": int(priority == "fastest"),
        "priorityCheapest": int(priority == "cheapest"),
        "priorityShortest": int(priority == "shortest"),
        "suitabilityScore": round(clamp(score), 2),
    }


def main() -> None:
    rng = random.Random(SEED)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fields = FEATURES + ["suitabilityScore"]
    with OUTPUT.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for _ in range(ROWS):
            writer.writerow(make_row(rng))
    print(f"Wrote {ROWS} reproducible simulated scenarios to {OUTPUT}")


if __name__ == "__main__":
    main()
