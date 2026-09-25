"use strict";

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const stationsRouter = require("./routes/stations");
const routingRouter = require("./routes/routing");
const recommendationsRouter = require("./routes/recommendations");
const trafficRouter = require("./routes/traffic");
const basemapRouter = require("./routes/basemap");
const feedbackRouter = require("./routes/feedback");
const authRouter = require("./routes/auth");
const listingsRouter = require("./routes/listings");
const { initDb } = require("./db");

// Accounts/listings need Postgres; everything else must work without it,
// so schema setup failure is logged, never fatal.
initDb().catch((err) => console.error("[db] init failed (auth/listings disabled):", err.message));

const app = express();

app.use(cors({ origin: (process.env.CORS_ORIGIN || "*") === "*" ? "*" : process.env.CORS_ORIGIN.split(",") }));
app.use(express.json({ limit: "100kb" }));
app.use(morgan("tiny"));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiter);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "voltroute-ev-locator", time: new Date().toISOString() });
});
app.get("/api/config", (req, res) => {
  // Frontend-safe config only — never leak keys.
  res.json({
    mapAttribution: "© OpenStreetMap contributors © CARTO",
    city: "Bengaluru, Karnataka",
    trafficOverlay: trafficRouter.trafficOverlayEnabled(),
    basemapTiles: basemapRouter.basemapEnabled() ? "/api/basemap-tile/{z}/{x}/{y}" : null,
  });
});

app.use("/api/stations", stationsRouter);
app.use("/api/route", routingRouter);
app.use("/api/recommendations", recommendationsRouter);
app.use("/api/traffic-tile", trafficRouter);
app.use("/api/basemap-tile", basemapRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/auth", authRouter);
app.use("/api/listings", listingsRouter);

// Serve the static frontend (repo root) — works for `npm start` without a second server.
app.use(express.static(path.join(__dirname, "..")));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Keep diagnostics on the server while preserving the generic client response.
  console.error("API error:", err.message);
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  // Never leak internals: unexpected failures get a generic message.
  const message = err.status ? err.message || "Request failed." : "Internal server error.";
  res.status(status).json({ error: message });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

module.exports = app;
