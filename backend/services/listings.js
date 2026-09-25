"use strict";

// Owner-submitted station listings ("community" source). Prototype policy:
// submissions are approved immediately so owners see their station on the map
// without an admin queue. Revisit before any production use.

const { getPool } = require("../db");

const CONNECTORS = new Set(["CCS2", "Type 2", "Type 1", "CHAdeMO", "Tesla", "GB/T DC", "GB/T AC", "Bharat AC-001", "Bharat DC-001"]);

function toStation(row) {
  let connectors = [];
  try {
    const parsed = JSON.parse(row.connectors || "[]");
    if (Array.isArray(parsed)) connectors = parsed.filter((c) => CONNECTORS.has(c)).slice(0, 6);
  } catch { /* fall through with empty connectors */ }
  const station = {
    id: `community-${row.id}`,
    sourceId: `community/${row.id}`,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    address: row.address || "Bengaluru, Karnataka",
    connectors,
    source: "community",
  };
  if (row.operator) station.operator = row.operator;
  const power = Number(row.power_kw);
  if (Number.isFinite(power) && power > 0) station.powerKw = power;
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
    `INSERT INTO station_listings (owner_id, name, lat, lng, address, connectors, power_kw, operator, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
    [ownerId, input.name, input.lat, input.lng, input.address || "",
     JSON.stringify(input.connectors), input.powerKw ?? null, input.operator || ""]
  );
  const [rows] = await getPool().query("SELECT * FROM station_listings WHERE id = ?", [result.insertId]);
  const row = rows[0];
  return { ...toStation(row), status: row.status };
}

module.exports = { CONNECTORS, toStation, getApprovedListings, getOwnerListings, createListing };
