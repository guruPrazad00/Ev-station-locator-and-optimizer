/* VoltRoute — Bengaluru EV map. Backend-driven; no keys in frontend. */
"use strict";

const BLR_CENTER = [12.9716, 77.5946];
const API = ""; // same origin: backend serves this page + /api/*
const REQUEST_TIMEOUT_MS = 20000;
const SEARCH_DEBOUNCE_MS = 350;

const state = {
  map: null,
  stationMarkers: new Map(), // id -> L.Marker
  stations: [], // last loaded set (live or curated fallback)
  visibleStations: [], // after connector + text filters
  selectedId: null,
  selectedRoute: null,
  userPos: null, // { lat, lng }
  userMarker: null,
  userAccuracy: null,
  routeLine: null,
  connector: "all",
  textFilter: "",
  provider: "",
  isFallback: false,
  nearbySeq: 0, // guards against stale out-of-order responses
  searchSeq: 0,
  routeCache: new Map(), // "fromLat,fromLng>toLat,toLng" -> route
  routePending: new Map(), // same key -> in-flight promise (dedupes taps)
  baseLayer: null, // CARTO basemap (proxied key) or key-free fallback
  trafficLayer: null, // optional TomTom flow overlay (only when backend enables it)
  lastAnalysis: null, // { batteryPct, priority } from the latest candidate ranking
};

const VEHICLES = {
  nexon: { name: "Tata Nexon EV", batteryKwh: 40.5, consumptionKwhPer100Km: 14.5, maxDcPowerKw: 50, connector: "CCS2" },
  "mg-zs": { name: "MG ZS EV", batteryKwh: 50.3, consumptionKwhPer100Km: 17.2, maxDcPowerKw: 50, connector: "CCS2" },
  ather: { name: "Ather 450X", batteryKwh: 3.7, consumptionKwhPer100Km: 3.2, maxDcPowerKw: 7.2, connector: "Type 2" },
};

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const listEl = $("#station-list");
const countEl = $("#count");
const detailEl = $("#detail");
const clearRouteBtn = $("#clear-route-btn");
const locateBtn = $("#locate-btn");
const searchInput = $("#search");
const dataSourceEl = $("#data-source");
const statCountEl = $("#stat-count");
const statSourceEl = $("#stat-source");
const statFillEl = $("#stat-fill");

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Detect mobile layout for scroll behavior.
function isMobile() {
  return window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad|iPod/.test(navigator.userAgent);
}

// Wrap geolocation in a promise so callers can await the user's location.
function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error({ 1: "Location permission denied.", 2: "Location unavailable.", 3: "Location request timed out." }[err.code] || "Could not get your location.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

// Scroll the page to the map section on mobile so the route is visible.
function scrollToMap() {
  if (!isMobile()) return;
  const mapWrap = document.querySelector(".map-wrap") || document.getElementById("map");
  if (mapWrap) mapWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setDataSourceNote() {
  if (!dataSourceEl) return;
  dataSourceEl.textContent = state.provider
    ? ` · Stations: ${state.candidateMode ? "prototype simulated candidate data" : state.isFallback ? "demo data (live unavailable)" : state.provider}`
    : "";
  if (statSourceEl) {
    statSourceEl.textContent = !state.provider
      ? "Connecting to station data…"
      : state.candidateMode
        ? "AI ranking · simulated training data"
      : state.isFallback
        ? "Demo data — live service unavailable"
        : `Live data · ${state.provider}`;
  }
}

// fetch with client-side timeout so slow requests fail cleanly.
async function api(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out. Please retry.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Fire-and-forget choice logging for future observed-outcome training.
// Never blocks UI, never sends user coordinates, never surfaces errors.
function logChoice(action, station) {
  try {
    if (!station || !station.id) return;
    const body = { stationId: station.id, action };
    if (station.features && typeof station.features === "object") body.features = station.features;
    if (Number.isFinite(station.aiScore)) body.aiScore = station.aiScore;
    if (state.lastAnalysis) {
      if (Number.isFinite(state.lastAnalysis.batteryPct)) body.batteryPct = state.lastAnalysis.batteryPct;
      if (state.lastAnalysis.priority) body.priority = state.lastAnalysis.priority;
    }
    fetch(`${API}/api/feedback/choice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch { /* logging must never break the app */ }
}

const BASEMAP_FALLBACK = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

function initMap() {
  state.map = L.map("map", { zoomControl: false }).setView(BLR_CENTER, 12);
  // Top-right: bottom-right would hide behind the bottom-docked detail card.
  L.control.zoom({ position: "topright" }).addTo(state.map);
  // Keyed Voyager tiles via our proxy when configured, else key-free tiles.
  api("/api/config")
    .then((config) => addBaseLayer(config && config.basemapTiles))
    .catch(() => addBaseLayer(null));
}

function addBaseLayer(template) {
  if (state.baseLayer) {
    state.baseLayer.remove();
    state.baseLayer = null;
  }
  state.baseLayer = L.tileLayer(template || BASEMAP_FALLBACK, {
    maxZoom: 20,
    subdomains: template ? "" : "abcd",
    attribution: "© OpenStreetMap contributors © CARTO",
  }).addTo(state.map);
}

function stationPopup(s) {
  const connectors = (s.connectors || []).join(", ") || "Unknown";
  return `<strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(s.address || "")}<br><small>${escapeHtml(connectors)}${s.powerKw ? ` · ${s.powerKw} kW` : " · Power unknown"}</small>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function matchesConnector(s, want) {
  if (!want || want === "all") return true;
  const w = want.toLowerCase();
  return (s.connectors || []).some((c) => {
    const cl = String(c).toLowerCase();
    return cl === w || cl.includes(w) || w.includes(cl);
  });
}

function applyFilters() {
  const q = state.textFilter.trim().toLowerCase();
  state.visibleStations = state.stations.filter((s) => {
    if (!matchesConnector(s, state.connector)) return false;
    if (!q) return true;
    return (
      (s.name || "").toLowerCase().includes(q) ||
      (s.address || "").toLowerCase().includes(q) ||
      (s.operator || "").toLowerCase().includes(q)
    );
  });
  if (state.selectedId && !state.visibleStations.some((s) => s.id === state.selectedId)) {
    state.selectedId = null;
    state.selectedRoute = null;
    detailEl.hidden = true;
    clearRoute();
  }
  renderMarkers();
  renderList();
}

function renderMarkers() {
  for (const marker of state.stationMarkers.values()) marker.remove();
  state.stationMarkers.clear();
  const bounds = [];
  for (const s of state.visibleStations) {
    const m = L.marker([s.lat, s.lng], { title: s.name })
      .addTo(state.map)
      .bindPopup(stationPopup(s))
      .on("click", () => selectStation(s.id));
    state.stationMarkers.set(s.id, m);
    bounds.push([s.lat, s.lng]);
  }
  if (state.userPos) bounds.push([state.userPos.lat, state.userPos.lng]);
  if (bounds.length > 1 && !state.selectedId) state.map.flyToBounds(bounds, { padding: [40, 40], duration: 0.6 });
}

function sourceLabel(s) {
  if (s.dataMode === "simulated") return "Prototype candidate";
  if (s.source === "community") return "Community";
  if (s.source === "googleplaces") return "Live · Google Places";
  if (s.source === "openstreetmap") return "Live · OSM";
  if (s.source === "openchargemap") return "Live · OCM";
  return "Demo/Fallback";
}

// Display helpers: missing upstream data is labelled Unknown, never guessed.
function connectorText(s) {
  return (s.connectors && s.connectors.length ? s.connectors.join(" · ") : "Unknown");
}

function operatorText(s) {
  return s.operator || "Unknown";
}

function powerText(s) {
  return s.powerKw ? `${s.powerKw} kW` : "Power unknown";
}

function candidateText(s) {
  if (s.dataMode !== "simulated") return "";
  const traffic = s.trafficMode === "live"
    ? ` · 🚦 live traffic ${s.trafficPct}%`
    : ` · traffic ${s.trafficPct}% (simulated)`;
  return `${s.availableSlots}/${s.totalSlots} available · ${s.crowdPct}% crowd · ~${s.estimatedWaitMin} min wait · ₹${s.pricePerKwh}/kWh${traffic}`;
}

function renderList() {
  const n = state.visibleStations.length;
  countEl.textContent = state.candidateMode
    ? `${n} FEASIBLE CANDIDATE${n === 1 ? "" : "S"}`
    : `${n} MATCH${n === 1 ? "" : "ES"} — NEAREST FIRST`;
  if (statCountEl) statCountEl.textContent = n ? `${n}` : "—";
  if (statFillEl) statFillEl.style.width = `${Math.min(100, Math.round((n / 60) * 100))}%`;
  listEl.innerHTML = "";
  if (!n) {
    const empty = document.createElement("div");
    empty.className = "empty-card";
    const hasFilter = state.connector !== "all" || state.textFilter.trim();
    empty.innerHTML = hasFilter
      ? `<p>No stations match the current search/filters.</p><button type="button" class="ghost" id="reset-filters">Reset search &amp; filters</button>`
      : `<p>No stations found here yet.</p><button type="button" class="ghost" id="retry-load">Retry</button>`;
    listEl.appendChild(empty);
    const reset = $("#reset-filters");
    if (reset) reset.onclick = () => { setConnector("all"); searchInput.value = ""; state.textFilter = ""; applyFilters(); };
    const retry = $("#retry-load");
    if (retry) retry.onclick = () => reloadCurrent();
    return;
  }
  for (const s of state.visibleStations) {
    const card = document.createElement("article");
    card.className = "station" + (s.id === state.selectedId ? " selected" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const idx = state.visibleStations.indexOf(s);
    const isLive = s.source === "openstreetmap" || s.source === "openchargemap" || s.source === "googleplaces";
    const badge = s.dataMode === "simulated" ? "CANDIDATE" : s.source === "community" ? "COMMUNITY" : isLive ? "LIVE" : "DEMO";
    const dist = typeof s.distanceKm === "number" ? `${s.distanceKm} km away` : "Distance unknown";
    card.innerHTML = `
      <div class="rank">${String(idx + 1).padStart(2, "0")}</div>
      <div class="station-content">
        <div class="station-title"><h3>${escapeHtml(s.name)}</h3><span class="badge${badge === "DEMO" ? " demo" : ""}">${badge}</span></div>
        <p class="reason">${s.aiScore !== undefined ? `AI suitability ${s.aiScore}/100 · ` : ""}${escapeHtml(dist)} · ${escapeHtml(s.address || "")}</p>
        <div class="details">
          <span>${escapeHtml(connectorText(s))}</span>
          <span>${escapeHtml(powerText(s))}</span>
          <span>${escapeHtml(operatorText(s))}</span>
          ${s.chargingLevels ? `<span>Level ${escapeHtml(s.chargingLevels.join(" / "))}</span>` : ""}
        </div>
        ${candidateText(s) ? `<p class="distance">${escapeHtml(candidateText(s))}</p>` : ""}
      </div>
      <div class="station-action">
        <span class="status">${escapeHtml(s.aiScore !== undefined ? `${s.aiScore}/100 AI` : typeof s.distanceKm === "number" ? `${s.distanceKm} km` : powerText(s))}</span>
        <button type="button" class="preview">Directions →</button>
      </div>`;
    card.addEventListener("click", () => selectStation(s.id));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectStation(s.id); } });
    const go = card.querySelector(".preview");
    if (go) go.addEventListener("click", (e) => { e.stopPropagation(); selectStation(s.id); });
    listEl.appendChild(card);
  }
  const sel = listEl.querySelector(".station.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function updatedNote(s) {
  if (!s.updatedAt) return "updated Unknown";
  const d = new Date(s.updatedAt);
  if (Number.isNaN(d.getTime())) return "updated Unknown";
  return `updated ${d.toLocaleDateString()}`;
}

function sourceRef(s) {
  const parts = [sourceLabel(s), s.sourceId, updatedNote(s)].filter(Boolean);
  return parts.join(" · ");
}

function showDetail(s, route, routeError) {
  detailEl.hidden = false;
  detailEl.scrollIntoView({ block: "nearest" });
  const mapsUrl = state.userPos
    ? `https://www.google.com/maps/dir/?api=1&origin=${state.userPos.lat},${state.userPos.lng}&destination=${s.lat},${s.lng}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
  detailEl.innerHTML = `
    <button class="detail-close" aria-label="Close details">×</button>
    <h3>${escapeHtml(s.name)}</h3>
    ${typeof s.distanceKm === "number" || route ? `<p class="route-info">📍 ${route ? route.traffic ? `${route.distanceKm} km · ~${route.traffic.durationMin} min with traffic` : `${route.distanceKm} km · ~${route.durationMin} min drive` : `${s.distanceKm} km away`}</p>` : ""}
    <p class="address">${escapeHtml(s.address || "")}</p>
    ${candidateText(s) ? `<p class="address">${escapeHtml(candidateText(s))}</p>` : ""}
    <div class="details">
      <span>${escapeHtml(connectorText(s))}</span>
      <span>${escapeHtml(powerText(s))}</span>
      <span>${escapeHtml(operatorText(s))}</span>
      ${s.chargingLevels ? `<span>Level ${escapeHtml(s.chargingLevels.join(" / "))}</span>` : ""}
      ${s.currentType ? `<span>${escapeHtml(s.currentType)}</span>` : ""}
      ${s.voltage ? `<span>${escapeHtml(s.voltage)}</span>` : ""}
      ${s.amperage ? `<span>${escapeHtml(s.amperage)}</span>` : ""}
      ${s.status ? `<span>Status: ${escapeHtml(s.status)}</span>` : ""}
      ${s.aiScore !== undefined ? `<span>AI ${escapeHtml(s.aiScore)}/100</span>` : ""}
    </div>
    <p class="source-ref">${escapeHtml(sourceRef(s))}</p>
    ${route ? "" : routeError
      ? `<p class="route-hint">Route unavailable (${escapeHtml(routeError)}). Tap Directions to retry.</p>`
      : `<p class="route-hint">Enable “◎” location to see the driving route here.</p>`}
    <div class="detail-actions">
      <button type="button" class="primary" id="detail-directions">Directions</button>
      <a class="ghost" id="detail-maps" href="${mapsUrl}" target="_blank" rel="noopener">Open in Maps</a>
      <button type="button" class="ghost" id="detail-clear">Clear</button>
    </div>
    <div class="detail-actions">
      <button type="button" class="ghost" id="detail-good" aria-label="Good stop">👍 Good stop</button>
      <button type="button" class="ghost" id="detail-bad" aria-label="Bad stop">👎 Not good</button>
    </div>
  `;
  detailEl.querySelector(".detail-close").onclick = closeDetail;
  detailEl.querySelector("#detail-clear").onclick = closeDetail;
  detailEl.querySelector("#detail-good").onclick = () => {
    logChoice("good", s);
    setStatus("Thanks — your rating was recorded for research.");
  };
  detailEl.querySelector("#detail-bad").onclick = () => {
    logChoice("bad", s);
    setStatus("Thanks — your rating was recorded for research.");
  };
  detailEl.querySelector("#detail-directions").onclick = async () => {
    if (!state.userPos) {
      setStatus("Locating you… Please allow location access to draw the driving route.");
      try {
        const pos = await getUserLocation();
        setUserPos(pos.lat, pos.lng, pos.accuracy);
        state.map.setView([pos.lat, pos.lng], 13);
        scrollToMap();
      } catch (err) {
        setStatus(`${err.message} Showing central Bengaluru instead. Open in Maps for directions.`);
        scrollToMap();
        return;
      }
    }
    logChoice("directions", s);
    scrollToMap();
    if (state.routeLine) state.map.fitBounds(state.routeLine.getBounds(), { padding: [50, 50] });
    else selectStation(s.id);
  };
}

function closeDetail() {
  detailEl.hidden = true;
  state.selectedId = null;
  state.selectedRoute = null;
  clearRoute();
  renderList(); // markers unchanged throughout selection — no redraw needed
}

function drawRoute(geometry) {
  clearRouteLine();
  const latlngs = geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  state.routeLine = L.polyline(latlngs, { weight: 5, opacity: 0.9 }).addTo(state.map);
  const bounds = state.routeLine.getBounds();
  if (state.userPos) bounds.extend([state.userPos.lat, state.userPos.lng]);
  state.map.flyToBounds(bounds, { padding: [50, 50], duration: 0.6 });
  clearRouteBtn.hidden = false;
}

function clearRouteLine() {
  if (state.routeLine) { state.routeLine.remove(); state.routeLine = null; }
}

function clearRoute() {
  clearRouteLine();
  clearRouteBtn.hidden = true;
}

function routeKey(from, to) {
  return `${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
}

async function fetchRoute(from, to) {
  const key = routeKey(from, to);
  if (state.routeCache.has(key)) return state.routeCache.get(key);
  if (state.routePending.has(key)) return state.routePending.get(key);
  const p = api(
    `/api/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}`
  ).then((route) => {
    state.routeCache.set(key, route);
    if (state.routeCache.size > 100) state.routeCache.delete(state.routeCache.keys().next().value);
    state.routePending.delete(key);
    return route;
  }).catch((err) => {
    state.routePending.delete(key);
    throw err;
  });
  state.routePending.set(key, p);
  return p;
}

async function selectStation(id) {
  const station = state.visibleStations.find((s) => s.id === id)
    || state.stations.find((s) => s.id === id);
  if (!station) return;
  state.selectedId = id;
  logChoice("select", station);
  renderList(); // cards only — markers are untouched (no full map redraw)
  const marker = state.stationMarkers.get(id);
  if (marker) {
    // Details live in the results column now: never cover the map with a popup.
    state.map.panTo([station.lat, station.lng], { animate: true });
  }
  if (!state.userPos) {
    setStatus("Locating you… Please allow location access to draw the driving route.");
    try {
      const pos = await getUserLocation();
      setUserPos(pos.lat, pos.lng, pos.accuracy);
      state.map.setView([pos.lat, pos.lng], 13);
      scrollToMap();
    } catch (err) {
      state.selectedRoute = null;
      showDetail(station, null);
      setStatus(`${err.message} Showing central Bengaluru instead. Open in Maps for directions.`);
      return;
    }
  }
  // Same station re-tapped and route already known: reuse, no new request.
  if (state.selectedRoute && state.selectedRoute.stationId === id && state.routeLine) {
    showDetail(station, state.selectedRoute);
    return;
  }
  try {
    setStatus(`Calculating route to “${station.name}”…`);
    const route = await fetchRoute(state.userPos, station);
    if (state.selectedId !== id) return; // user moved on while loading
    // Candidate mode already resolved this station's road-route ETA during
    // ranking: reuse it for display so card, detail, and status always agree.
    // The fetch above still runs for the polyline geometry (server-cached).
    const candidateEta = state.candidateMode && Number.isFinite(station.estimatedDriveMin)
      ? station.estimatedDriveMin
      : null;
    const effective = candidateEta !== null
      ? {
          ...route,
          durationMin: candidateEta,
          traffic: {
            durationMin: candidateEta,
            trafficPct: Number.isFinite(station.trafficPct)
              ? station.trafficPct
              : route.traffic?.trafficPct ?? null,
            samples: route.traffic?.samples ?? 0,
            cruiseKmh: route.traffic?.cruiseKmh ?? 50,
          },
        }
      : route;
    state.selectedRoute = { ...effective, stationId: id };
    drawRoute(route.geometry);
    showDetail(station, effective);
    setStatus(effective.traffic && Number.isFinite(effective.traffic.trafficPct)
      ? `Route: ${effective.distanceKm} km · ~${effective.traffic.durationMin} min with traffic (${effective.traffic.trafficPct}% congestion) to “${station.name}”.`
      : `Route: ${effective.distanceKm} km · ~${effective.durationMin} min to “${station.name}”.`);
  } catch (err) {
    if (state.selectedId !== id) return;
    state.selectedRoute = null;
    showDetail(station, null, err.message);
    setStatus(`Could not calculate route: ${err.message}`);
  }
}

function setStations(data, label) {
  state.stations = data.stations || [];
  state.provider = data.provider || "";
  state.isFallback = Boolean(data.fallback) || data.provider === "curated-demo";
  setDataSourceNote();
  applyFilters();
}

async function analyzeCandidates() {
  const vehicleSelect = $("#vehicle-select");
  const batteryInput = $("#battery-input");
  const prioritySelect = $("#priority-select");
  const analyzeBtn = $("#analyze-btn");

  // Require the user's location before computing feasible chargers.
  if (!state.userPos) {
    setStatus("Please enable your location (◎) first — tap “Use my location” before finding feasible chargers.");
    analyzeBtn.disabled = false;
    return;
  }

  const vehicle = VEHICLES[vehicleSelect.value];
  const origin = state.userPos || { lat: BLR_CENTER[0], lng: BLR_CENTER[1] };
  const connector = vehicle.connector;
  const query = new URLSearchParams({
    lat: origin.lat,
    lng: origin.lng,
    radiusKm: "50",
    connector,
    batteryKwh: vehicle.batteryKwh,
    batteryPct: batteryInput.value,
    consumptionKwhPer100Km: vehicle.consumptionKwhPer100Km,
    maxDcPowerKw: vehicle.maxDcPowerKw,
    priority: prioritySelect.value,
  });
  analyzeBtn.disabled = true;
  setStatus("Checking compatible and reachable chargers…");
  try {
    const data = await api(`/api/recommendations/candidates?${query}`);
    state.candidateMode = true;
    state.selectedId = null;
    state.selectedRoute = null;
    detailEl.hidden = true;
    clearRoute();
    state.stations = data.candidates;
    state.visibleStations = data.candidates;
    state.provider = "prototype candidate data";
    state.isFallback = false;
    state.connector = connector;
    state.lastAnalysis = { batteryPct: Number(batteryInput.value), priority: prioritySelect.value };
    document.querySelectorAll("#filters .chip[data-connector]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.connector === connector);
    });
    setDataSourceNote();
    renderMarkers();
    renderList();
    const c = data.counts;
    const top = data.candidates[0];
    setStatus(top
      ? `${c.reachable} feasible ${connector} candidates ranked by AI. Top: “${top.name}” (${top.aiScore}/100). Range: ${data.usableRangeKm} km.`
      : `No feasible ${connector} candidates found within the ${data.usableRangeKm} km usable range.`);
  } catch (err) {
    setStatus(`Could not generate candidates: ${err.message}`);
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function loadNearby(lat, lng, label) {
  const seq = ++state.nearbySeq;
  setStatus(`Loading stations near ${label}…`);
  try {
    const data = await api(
      `/api/stations/nearby?lat=${lat}&lng=${lng}&radiusKm=25&limit=60&connector=${encodeURIComponent(state.connector)}`
    );
    if (seq !== state.nearbySeq) return; // stale response
    state.selectedId = null;
    state.selectedRoute = null;
    state.candidateMode = false;
    state.lastAnalysis = null;
    detailEl.hidden = true;
    clearRoute();
    state.textFilter = searchInput.value.trim();
    setStations(data, label);
    const where = state.isFallback ? `${label} (demo data — live service unavailable)` : label;
    setStatus(`${data.count} stations near ${where}. Select one for details and routing.`);
  } catch (err) {
    if (seq !== state.nearbySeq) return;
    state.stations = [];
    state.visibleStations = [];
    renderMarkers();
    listEl.innerHTML = `<div class="empty-card"><p>Couldn’t load stations: ${escapeHtml(err.message)}</p><button type="button" class="ghost" id="retry-load">Retry</button></div>`;
    countEl.textContent = "— stations";
    const retry = $("#retry-load");
    if (retry) retry.onclick = () => loadNearby(lat, lng, label);
    setStatus(`Error loading stations near ${label}.`);
  }
}

function reloadCurrent() {
  if (state.userPos) loadNearby(state.userPos.lat, state.userPos.lng, "you");
  else loadNearby(BLR_CENTER[0], BLR_CENTER[1], "Bengaluru");
}

async function searchBackend(q) {
  const seq = ++state.searchSeq;
  setStatus(`Searching for “${q}”…`);
  try {
    const data = await api(`/api/stations/search?q=${encodeURIComponent(q)}&limit=40&connector=${encodeURIComponent(state.connector)}`);
    if (seq !== state.searchSeq) return;
    state.selectedId = null;
    state.selectedRoute = null;
    state.candidateMode = false;
    state.lastAnalysis = null;
    detailEl.hidden = true;
    clearRoute();
    state.textFilter = ""; // backend already applied the text query
    setStations(data, q);
    if (data.stations.length) {
      state.map.flyToBounds(data.stations.map((s) => [s.lat, s.lng]), { padding: [40, 40], duration: 0.6 });
      setStatus(`${data.count} result${data.count === 1 ? "" : "s"} for “${q}” (demo directory).`);
    } else {
      setStatus(`No stations match “${q}”.`);
    }
  } catch (err) {
    if (seq !== state.searchSeq) return;
    setStatus(`Search failed: ${err.message}`);
  }
}

function setConnector(value) {
  state.connector = value;
  document.querySelectorAll("#filters .chip[data-connector]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.connector === value);
  });
  // Filter the already-loaded normalized set locally: no extra API call.
  // The connector is also sent on the next backend load/search.
  applyFilters();
  const n = state.visibleStations.length;
  setStatus(n
    ? `${n} station${n === 1 ? "" : "s"} match this filter.`
    : "No loaded stations match this filter.");
}

function setUserPos(lat, lng, accuracy, { reload = true } = {}) {
  state.userPos = { lat, lng };
  if (state.userMarker) state.userMarker.remove();
  if (state.userAccuracy) state.userAccuracy.remove();
  if (Number.isFinite(accuracy)) {
    state.userAccuracy = L.circle([lat, lng], {
      radius: Math.min(accuracy, 2000),
      color: "#16795d",
      weight: 1,
      opacity: 0.4,
      fillOpacity: 0.08,
    }).addTo(state.map);
  }
  state.userMarker = L.circleMarker([lat, lng], {
    radius: 9,
    color: "#fff",
    weight: 3,
    fillColor: "#16795d",
    fillOpacity: 1,
  })
    .addTo(state.map)
    .bindPopup("<strong>You are here</strong>");
  if (reload) loadNearby(lat, lng, "you").catch(() => {});
}

function locateUser() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation is not supported by this browser. Showing central Bengaluru.");
    return;
  }
  const locateBig = $("#locate-big");
  const setLocating = (on) => {
    locateBtn.disabled = on;
    locateBtn.classList.toggle("busy", on);
    if (locateBig) {
      locateBig.disabled = on;
      locateBig.classList.toggle("busy", on);
    }
  };
  setLocating(true);
  setStatus("Locating you…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setLocating(false);
      setUserPos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      state.map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    },
    (err) => {
      setLocating(false);
      const reasons = { 1: "Location permission denied.", 2: "Location unavailable.", 3: "Location request timed out." };
      setStatus(`${reasons[err.code] || "Could not get your location."} Showing central Bengaluru instead.`);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function initUI() {
  const vehicleSelect = $("#vehicle-select");
  const batteryInput = $("#battery-input");
  const batteryValue = $("#battery-value");
  const syncBattery = () => { batteryValue.textContent = `${batteryInput.value}%`; };
  batteryInput.addEventListener("input", syncBattery);
  vehicleSelect.addEventListener("change", () => {
    const vehicle = VEHICLES[vehicleSelect.value];
    if (vehicle && vehicle.connector !== state.connector) setConnector(vehicle.connector);
  });
  $("#analyze-btn").addEventListener("click", analyzeCandidates);
  $("#search-btn").addEventListener("click", () => {
    const q = searchInput.value.trim();
    if (!q) return reloadCurrent();
    searchBackend(q);
  });
  // Debounced typing filters the loaded stations locally (no network);
  // Enter/Search queries the backend directory.
  searchInput.addEventListener("input", debounce(() => {
    state.textFilter = searchInput.value.trim();
    state.searchSeq++; // cancel any in-flight backend search made stale
    applyFilters();
  }, SEARCH_DEBOUNCE_MS));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = searchInput.value.trim();
      if (!q) return reloadCurrent();
      searchBackend(q);
    }
  });
  document.querySelectorAll("#filters .chip[data-connector]").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (chip.dataset.connector !== state.connector) setConnector(chip.dataset.connector);
    });
  });
  locateBtn.addEventListener("click", locateUser);
  const locateBig = $("#locate-big");
  if (locateBig) locateBig.addEventListener("click", locateUser);
  clearRouteBtn.addEventListener("click", closeDetail);
  initTrafficToggle();
  initSplitter();
}

// Optional TomTom traffic-flow overlay. The tile key never reaches the
// browser: /api/config only advertises a boolean, tiles come from our proxy.
function initTrafficToggle() {
  const chip = $("#traffic-chip");
  if (!chip) return;
  const setLayer = (on) => {
    if (on && !state.trafficLayer) {
      state.trafficLayer = L.tileLayer("/api/traffic-tile/{z}/{x}/{y}", {
        maxZoom: 19,
        opacity: 0.7,
        attribution: "Traffic © TomTom",
      }).addTo(state.map);
    } else if (!on && state.trafficLayer) {
      state.trafficLayer.remove();
      state.trafficLayer = null;
    }
    chip.classList.toggle("active", on);
    const legend = $("#legend-traffic");
    if (legend) legend.hidden = false; // layer exists while configured, even if toggled off
  };
  api("/api/config")
    .then((config) => {
      if (!config || !config.trafficOverlay) return; // stays hidden
      chip.hidden = false;
      setLayer(true); // auto-enable: traffic on by default, chip toggles it off
      chip.addEventListener("click", () => setLayer(!state.trafficLayer));
    })
    .catch(() => { /* overlay stays hidden when config is unreachable */ });
}

// Desktop splitter: drag (or arrow keys) to resize list vs map panels.
// Persists the width; Leaflet is told to re-measure after every change.
function initSplitter() {
  const splitter = $("#splitter");
  const workspace = document.querySelector(".workspace");
  if (!splitter || !workspace) return;
  const MIN_W = 240;
  const MAX_W = 560;
  const KEY = "voltroute-side-w";
  const apply = (px) => {
    const clamped = Math.min(MAX_W, Math.max(MIN_W, Math.round(px)));
    workspace.style.setProperty("--side-w", `${clamped}px`);
    splitter.setAttribute("aria-valuenow", String(clamped));
    if (state.map && state.map.invalidateSize) state.map.invalidateSize();
    return clamped;
  };
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W) {
      workspace.style.setProperty("--side-w", `${saved}px`);
    }
  } catch { /* private mode: skip persistence */ }
  splitter.setAttribute("role", "separator");
  splitter.addEventListener("keydown", (e) => {
    const cur = workspace.querySelector(".sheet").getBoundingClientRect().width || 340;
    if (e.key === "ArrowLeft") { e.preventDefault(); persist(apply(cur - 20)); }
    if (e.key === "ArrowRight") { e.preventDefault(); persist(apply(cur + 20)); }
  });
  const persist = (px) => {
    try { localStorage.setItem(KEY, String(px)); } catch { /* ignore */ }
  };
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = workspace.querySelector(".sheet").getBoundingClientRect().width || 340;
    const move = (ev) => apply(startW + (ev.clientX - startX));
    const up = (ev) => {
      const final = apply(startW + (ev.clientX - startX));
      persist(final);
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });
}

initMap();
initUI();
loadNearby(BLR_CENTER[0], BLR_CENTER[1], "Bengaluru");

