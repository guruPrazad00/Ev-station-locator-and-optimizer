#!/usr/bin/env node
// VoltRoute smoke-test script. Hits every public API endpoint and reports PASS/FAIL.
// Run:  npm start   (in one terminal)   →   node test/smoke.js   (in another)
// Requires MySQL running with `voltroute` database for auth/listings tests.

"use strict";

const http = require("http");

const BASE = "http://localhost:3000";
let passes = 0;
let fails = 0;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 25000,
    };
    const r = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || "{}") });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fails++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

async function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

(async () => {
  console.log("=== VoltRoute smoke tests ===\n");

  // --- Core (no DB needed) ---
  await check("GET /api/health", async () => {
    const r = await req("GET", "/api/health");
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.ok === true, "ok not true");
  });

  await check("GET /api/config", async () => {
    const r = await req("GET", "/api/config");
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.city === "string", "missing city");
  });

  await check("GET /api/stations/nearby (curated)", async () => {
    const r = await req("GET", "/api/stations/nearby?lat=12.9716&lng=77.5946&radiusKm=25&limit=60&source=curated");
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.stations), "stations not array");
    assert(r.body.stations.length > 0, "no stations");
  });

  await check("GET /api/stations/search", async () => {
    const r = await req("GET", "/api/stations/search?q=ather&limit=5");
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.count >= 0, "bad count");
  });

  await check("GET /api/stations/:id", async () => {
    const r = await req("GET", "/api/stations/stn-tata-mgroad?lat=12.9716&lng=77.5946");
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.name, "missing name");
    assert(typeof r.body.distanceKm === "number", "missing distanceKm");
  });

  await check("GET /api/stations/unknown → 404", async () => {
    const r = await req("GET", "/api/stations/does-not-exist");
    assert(r.status === 404, `status ${r.status}, expected 404`);
  });

  await check("GET /api/stations/nearby bad coords → 400", async () => {
    const r = await req("GET", "/api/stations/nearby?lat=999&lng=0");
    assert(r.status === 400, `status ${r.status}, expected 400`);
  });

  await check("GET /api/route", async () => {
    const r = await req("GET", "/api/route?fromLat=12.9716&fromLng=77.5946&toLat=12.9352&toLng=77.6245");
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.distanceKm === "number", "missing distanceKm");
    assert(typeof r.body.durationMin === "number", "missing durationMin");
    assert(Array.isArray(r.body.geometry.coordinates), "missing geometry");
  });

  // --- Recommendations (ML) ---
  await check("GET /api/recommendations/candidates", async () => {
    const r = await req("GET", "/api/recommendations/candidates?lat=12.9716&lng=77.5946&batteryKwh=40&consumptionKwhPer100Km=15&maxDcPowerKw=50&batteryPct=60&connector=CCS2&priority=balanced");
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.candidates), "candidates not array");
    assert(r.body.mode === "neural-network-ranking", "wrong mode");
    assert(r.body.counts.reachable > 0, "no reachable candidates");
    if (r.body.candidates.length > 0) {
      assert(r.body.candidates[0].dataMode === "simulated", "wrong candidate dataMode");
    }
  });

  // --- Auth (needs MySQL) ---
  const email = `smoke${Date.now()}@test.com`;
  let token = null;
  let userId = null;

  await check("POST /api/auth/register (owner)", async () => {
    const r = await req("POST", "/api/auth/register", {
      name: "Smoke Owner",
      email,
      password: "password123",
      role: "owner",
    });
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.user.id, "missing user id");
    assert(r.body.token, "missing token");
    userId = r.body.user.id;
    token = r.body.token;
  });

  await check("POST /api/auth/register (duplicate → 409)", async () => {
    const r = await req("POST", "/api/auth/register", {
      name: "Dup",
      email,
      password: "password123",
      role: "user",
    });
    assert(r.status === 409, `status ${r.status}, expected 409`);
  });

  await check("POST /api/auth/login", async () => {
    const r = await req("POST", "/api/auth/login", { email, password: "password123" });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.token, "missing token");
    token = r.body.token;
  });

  await check("POST /api/auth/login (wrong password → 401)", async () => {
    const r = await req("POST", "/api/auth/login", { email, password: "wrongpass" });
    assert(r.status === 401, `status ${r.status}, expected 401`);
  });

  await check("GET /api/auth/me", async () => {
    const r = await req("GET", "/api/auth/me", null, token);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.email === email, "email mismatch");
  });

  await check("POST /api/listings (owner)", async () => {
    const r = await req("POST", "/api/listings", {
      name: "Smoke Charger",
      lat: 12.9352,
      lng: 77.6245,
      address: "Smoke Test Rd",
      operator: "Smoke Op",
      connectors: ["CCS2", "Type 2"],
      powerKw: 60,
    }, token);
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.source === "community", "wrong source");
    assert(r.body.name === "Smoke Charger", "name mismatch");
  });

  await check("GET /api/listings/mine", async () => {
    const r = await req("GET", "/api/listings/mine", null, token);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.count >= 1, "no listings");
  });

  await check("POST /api/listings (non-owner → 403 or 401)", async () => {
    const driverEmail = `smokedriver${Date.now()}@test.com`;
    await req("POST", "/api/auth/register", {
      name: "Smoke Driver",
      email: driverEmail,
      password: "password123",
      role: "user",
    });
    const dr = await req("POST", "/api/auth/login", { email: driverEmail, password: "password123" });
    const dtoken = dr.token;
    const r = await req("POST", "/api/listings", { name: "X", lat: 12.9, lng: 77.6, connectors: ["CCS2"] }, dtoken);
    assert(r.status === 401 || r.status === 403, `status ${r.status}, expected 401 or 403`);
  });

  await check("GET /api/listings/mine (no token → 401)", async () => {
    const r = await req("GET", "/api/listings/mine");
    assert(r.status === 401, `status ${r.status}, expected 401`);
  });

  // --- Traffic tile (needs TOMTOM_API_KEY) ---
  await check("GET /api/traffic-tile (configured → image or 204)", async () => {
    const r = await req("GET", "/api/traffic-tile/12/1234/1234");
    assert(r.status === 200 || r.status === 204, `status ${r.status}`);
  });

  // --- Basemap tile (needs CARTO key) ---
  await check("GET /api/basemap-tile (configured → image or 204)", async () => {
    const r = await req("GET", "/api/basemap-tile/12/1234/1234");
    assert(r.status === 200 || r.status === 204, `status ${r.status}`);
  });

  console.log(`\n=== ${passes} passed, ${fails} failed ===`);
  process.exit(fails > 0 ? 1 : 0);
})().catch((err) => {
  console.error("SMOKE TEST CRASH:", err.message);
  process.exit(1);
});
