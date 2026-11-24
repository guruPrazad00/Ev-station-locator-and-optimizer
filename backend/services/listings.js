"use strict";

// Owner-submitted station listings ("community" source). Prototype policy:
// submissions are approved immediately so an owner sees their station on the
// map without an admin queue. Add moderation before any production use.

const { getPool } = require("../db");

const CONNECTORS = new Set([
  "CCS2", "Type 2", "Type 1", "CHAdeMO", "Tesla",
  "GB/T DC", "GB/T AC", "Bharat AC-001", "Bharat DC-001",
]);

function parseConnectors(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => CONNECTORS.has(c)).slice(0, 8);
  } catch {
    return [];
  }
}

// Shape a database row like every other station the API returns.
function toStation(row) {
  const station = {
    id: `community-${row.id}`,
    sourceId: `community/${row.id}`,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    address: row.address || [row.city, row.state].filter(Boolean).join(", ") || "Bengaluru, Karnataka",
    connectors: parseConnectors(row.connectors),
    source: "community",
  };
  if (row.operator) station.operator = row.operator;
  const power = Number(row.power_kw);
  if (Number.isFinite(power) && power > 0) station.powerKw = power;
  if (row.phone) station.phone = row.phone;
  if (row.city) station.city = row.city;
  if (row.state) station.state = row.state;
  if (row.postal_code) station.postalCode = row.postal_code;
  const points = Number(row.charging_points);
  if (Number.isInteger(points) && points > 0) station.chargingPoints = points;
  if (row.tariff) station.tariff = row.tariff;
  if (row.opening_hours) station.openingHours = row.opening_hours;
  if (row.operational_status) station.operationalStatus = row.operational_status;
  if (row.image_url) station.imageUrl = row.image_url;
  return station;
}

async function getApprovedListings() {
  const [rows] = await getPool().query(
    "SELECT * FROM station_listings WHERE status = 'approved' ORDER BY id DESC LIMIT 500"
  );
  return rows.map(toStation);
}

async function getOwnerListings(ownerId) {
  const [rows] = await getPool().query(
    "SELECT * FROM station_listings WHERE owner_id = ? ORDER BY id DESC LIMIT 200",
    [ownerId]
  );
  return rows.map((row) => ({ ...toStation(row), status: row.status }));
}

async function createListing(ownerId, input) {
  const [result] = await getPool().query(
    `INSERT INTO station_listings
       (owner_id, name, lat, lng, address, connectors, power_kw, operator, status,
        phone, city, state, postal_code, charging_points, tariff, opening_hours,
        operational_status, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerId,
      input.name,
      input.lat,
      input.lng,
      input.address || "",
      JSON.stringify(input.connectors),
      input.powerKw ?? null,
      input.operator || "",
      input.phone || "",
      input.city || "Bengaluru",
      input.state || "Karnataka",
      input.postalCode || "",
      input.chargingPoints ?? null,
      input.tariff || "",
      input.openingHours || "",
      input.operationalStatus || "operational",
      input.imageUrl || "",
    ]
  );
  const [rows] = await getPool().query("SELECT * FROM station_listings WHERE id = ?", [result.insertId]);
  const row = rows[0];
  return { ...toStation(row), status: row.status };
}

module.exports = { CONNECTORS, toStation, getApprovedListings, getOwnerListings, createListing };
