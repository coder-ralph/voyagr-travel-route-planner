/**
 * VOYAGR v2 — Travel Route Planner ·  Made with ☕ by Ralph Rosael
 *
 * ══════════════════════════════════════════════════════════════
 *  NEW IN v2:
 *  ① Geocoding search bar  (Nominatim / Mapbox Geocoding API)
 *  ② Elevation profile     (Open-Elevation API + Chart.js)
 *  ③ Named stops           (modal prompt on add)
 *  ④ Route optimization    (TSP nearest-neighbor algorithm)
 *  ⑤ URL sharing           (base64-encoded hash)
 *  ⑥ Real road routing     (Mapbox Directions API)
 *
 * HOW TO ACTIVATE MAPBOX FEATURES (②road routing, geocoding):
 *   Replace MAPBOX_TOKEN below with your public token from
 *   https://account.mapbox.com/
 *
 * DISTANCE CALCULATION (Haversine):
 *   a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
 *   d = 2R·atan2(√a, √(1−a))   R = 6371 km
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// 1. CONFIGURATION
//
// ⚠️  DO NOT paste your real token here.
//
// The string 'pk.eyJ1…' is a safe placeholder that ships
// to GitHub.  build.js replaces it with the real token at deploy
// time, reading from the MAPBOX_TOKEN environment variable.
//
// Local dev:  copy .env.example → .env, add your token there.
//             Run  node build.js  once, then open index.html.
// Vercel:     add MAPBOX_TOKEN in Settings → Environment Variables.
//             The vercel.json buildCommand runs build.js automatically.
// ═══════════════════════════════════════════════════════════════
const MAPBOX_TOKEN = '%%MAPBOX_TOKEN%%'; // ← replaced by build.js, never a real token here

const HAS_MAPBOX = Boolean(MAPBOX_TOKEN)
  && !MAPBOX_TOKEN.startsWith('%%')
  && MAPBOX_TOKEN.length > 20;

const DEFAULT_CENTER = [48.8566, 2.3522];   // Paris
const DEFAULT_ZOOM   = 5;
const CAR_KMH        = 80;
const WALK_KMH       = 5;

const ROUTE_STYLE_STRAIGHT = {
  color: '#c9602b', weight: 3, opacity: .8, dashArray: '8 6',
};
const ROUTE_STYLE_ROAD = {
  color: '#2d7d46', weight: 4, opacity: .85,
};

// ═══════════════════════════════════════════════════════════════
// 2. STATE
// ═══════════════════════════════════════════════════════════════
let stops       = [];     // [{ lat, lng, name, marker, id, elevation? }]
let polylines   = [];     // Leaflet layer objects
let dragSrcIdx  = null;
let routingMode = 'straight'; // 'straight' | 'road'
let pendingAddLatLng = null;  // held while label modal is open
let elevationChart   = null;
let searchDebounce   = null;

// ═══════════════════════════════════════════════════════════════
// 3. MAP INIT
// ═══════════════════════════════════════════════════════════════
const map = L.map('map', { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM });

if (HAS_MAPBOX) {
  L.tileLayer(
    `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
    { tileSize: 512, zoomOffset: -1, maxZoom: 22,
      attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>' }
  ).addTo(map);
} else {
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  showToast('⚠️ No Mapbox token — using OpenStreetMap. Road routing & geocoding limited.', 6000);
}

// Loading spinner for road routing
const loadingEl = document.createElement('div');
loadingEl.className = 'route-loading';
loadingEl.innerHTML = '<div class="spinner"></div><span>Fetching road route…</span>';
document.querySelector('.map-container').appendChild(loadingEl);

// ═══════════════════════════════════════════════════════════════
// 4. MATH HELPERS
// ═══════════════════════════════════════════════════════════════
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtKm(km) {
  if (!isFinite(km) || km <= 0) return '—';
  if (km < 1)  return `${(km * 1000).toFixed(0)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${km.toFixed(0)} km`;
}

function fmtTime(hours) {
  if (!isFinite(hours) || hours <= 0) return '—';
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// 5. MARKERS
// ═══════════════════════════════════════════════════════════════
function makeIcon(label, type = 'mid') {
  // Clip label to ~5 chars for pin readability
  const display = String(label).length > 4 ? String(label).slice(0, 4) + '…' : label;
  const html = `<div class="custom-marker"><div class="marker-pin ${type}"><span class="pin-label">${display}</span></div></div>`;
  return L.divIcon({ html, className: '', iconAnchor: [16, 40], popupAnchor: [0, -42] });
}

// ═══════════════════════════════════════════════════════════════
// 6. ADD / REMOVE STOPS
// ═══════════════════════════════════════════════════════════════

/**
 * Called after modal confirms a label.
 * Finalises adding a stop to the state.
 */
function commitStop(lat, lng, name) {
  const id     = Date.now() + Math.random();
  const n      = stops.length + 1;
  const type   = 'mid'; // updated on refresh
  const marker = L.marker([lat, lng], { icon: makeIcon(n, type) })
    .addTo(map)
    .bindPopup(makePopupHTML({ lat, lng, name }, n));

  marker.on('click', () => marker.openPopup());

  stops.push({ lat, lng, name, marker, id });

  if (stops.length === 1) {
    document.getElementById('map-hint').classList.add('hidden');
  }

  refreshRoute();
  fetchElevations();
}

function removeStop(index) {
  if (index < 0 || index >= stops.length) return;
  map.removeLayer(stops[index].marker);
  stops.splice(index, 1);
  if (stops.length === 0) {
    document.getElementById('map-hint').classList.remove('hidden');
    hideElevation();
  }
  refreshRoute();
  fetchElevations();
}

function makePopupHTML(stop, n) {
  return `<div class="popup-inner">
    <div class="popup-title">${stop.name || 'Stop ' + n}</div>
    <div class="popup-coords">${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}</div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
// 7. LABEL MODAL  (③ Named stops)
// ═══════════════════════════════════════════════════════════════
const labelBackdrop = document.getElementById('label-modal-backdrop');
const labelInput    = document.getElementById('label-modal-input');
const labelCoords   = document.getElementById('modal-coords');

function openLabelModal(lat, lng, suggestedName = '') {
  pendingAddLatLng = { lat, lng };
  labelInput.value = suggestedName;
  labelCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  labelBackdrop.style.display = 'flex';
  setTimeout(() => labelInput.focus(), 80);
}

function closeLabelModal() {
  labelBackdrop.style.display = 'none';
  pendingAddLatLng = null;
  labelInput.value = '';
}

function confirmLabel() {
  if (!pendingAddLatLng) return;
  const { lat, lng } = pendingAddLatLng;
  const name = labelInput.value.trim() || `Stop ${stops.length + 1}`;
  closeLabelModal();
  commitStop(lat, lng, name);
}

document.getElementById('label-modal-confirm').addEventListener('click', confirmLabel);
document.getElementById('label-modal-skip').addEventListener('click', () => {
  if (!pendingAddLatLng) return;
  const { lat, lng } = pendingAddLatLng;
  closeLabelModal();
  commitStop(lat, lng, `Stop ${stops.length + 1}`);
});
document.getElementById('label-modal-close').addEventListener('click', closeLabelModal);
labelBackdrop.addEventListener('click', e => { if (e.target === labelBackdrop) closeLabelModal(); });
labelInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmLabel();
  if (e.key === 'Escape') closeLabelModal();
});

// ═══════════════════════════════════════════════════════════════
// 8. MAP CLICK
// ═══════════════════════════════════════════════════════════════
map.on('click', e => {
  openLabelModal(e.latlng.lat, e.latlng.lng);
});

// ═══════════════════════════════════════════════════════════════
// 9. ROUTE REFRESH  (straight-line or road geometry)
// ═══════════════════════════════════════════════════════════════
async function refreshRoute() {
  // Clear old lines
  polylines.forEach(p => map.removeLayer(p));
  polylines = [];

  // Update icons
  stops.forEach((s, i) => {
    const type  = i === 0 ? 'first' : i === stops.length - 1 ? 'last' : 'mid';
    const label = s.name || i + 1;
    s.marker.setIcon(makeIcon(label, type));
    s.marker.setPopupContent(makePopupHTML(s, i + 1));
  });

  if (stops.length < 2) {
    updateSidebar([], 0);
    updateSummary(0, []);
    updateUndoClear();
    return;
  }

  if (routingMode === 'road' && HAS_MAPBOX) {
    await drawRoadRoute();
  } else {
    drawStraightRoute();
  }
}

/* ─ Straight-line polylines ─ */
function drawStraightRoute() {
  const distances = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const d = haversineKm(stops[i].lat, stops[i].lng, stops[i+1].lat, stops[i+1].lng);
    distances.push(d);

    const line = L.polyline(
      [[stops[i].lat, stops[i].lng], [stops[i+1].lat, stops[i+1].lng]],
      ROUTE_STYLE_STRAIGHT
    ).addTo(map);
    animateLine(line);
    polylines.push(line);
  }

  const totalKm = distances.reduce((a, b) => a + b, 0);
  updateSidebar(distances, totalKm, 'straight');
  updateSummary(totalKm, []);
  updateRoutingBadge('straight');
  updateUndoClear();
}

/* ─ Real road routing via Mapbox Directions API ─ */
async function drawRoadRoute() {
  loadingEl.classList.add('visible');

  try {
    const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${encodeURIComponent(coords)}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.routes || !data.routes[0]) {
      showToast('Road routing failed — falling back to straight lines', 3500);
      drawStraightRoute();
      return;
    }

    const route    = data.routes[0];
    const geojson  = route.geometry;           // GeoJSON LineString
    const totalKm  = route.distance / 1000;    // metres → km
    const legs     = route.legs;               // per-segment info

    // Draw the full road geometry
    const line = L.geoJSON(geojson, { style: ROUTE_STYLE_ROAD }).addTo(map);
    polylines.push(line);

    // Per-leg distances
    const distances = legs.map(l => l.distance / 1000);

    updateSidebar(distances, totalKm, 'road');
    updateSummary(totalKm, legs.map(l => l.duration));
    updateRoutingBadge('road');
  } catch (err) {
    console.error('Directions API error:', err);
    showToast('Road routing error — using straight lines', 3500);
    drawStraightRoute();
  } finally {
    loadingEl.classList.remove('visible');
    updateUndoClear();
  }
}

function animateLine(line) {
  setTimeout(() => {
    const el = line.getElement?.();
    if (el) {
      el.animate(
        [{ strokeDashoffset: 1000 }, { strokeDashoffset: 0 }],
        { duration: 600, easing: 'ease', fill: 'forwards' }
      );
    }
  }, 0);
}

// ═══════════════════════════════════════════════════════════════
// 10. SIDEBAR
// ═══════════════════════════════════════════════════════════════
function updateSidebar(distances, totalKm, mode = 'straight') {
  const list  = document.getElementById('stop-list');
  const count = document.getElementById('stop-count');
  count.textContent = `${stops.length} stop${stops.length !== 1 ? 's' : ''}`;

  if (stops.length === 0) {
    list.innerHTML = `<li class="stop-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
      <p>Search for a place or click the map to add your first stop</p>
    </li>`;
    return;
  }

  const roadClass = mode === 'road' ? ' road' : '';
  const icon = mode === 'road'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l4-11 4 11M13 17l4-11 4 11"/><line x1="3" y1="17" x2="21" y2="17"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

  list.innerHTML = stops.map((s, i) => {
    const type = i === 0 ? 'first' : i === stops.length - 1 ? 'last' : 'mid';
    const distRow = i < stops.length - 1
      ? `<div class="stop-distance${roadClass}">${icon} ${fmtKm(distances[i])} ${mode === 'road' ? 'by road' : 'direct'}</div>`
      : `<div class="stop-distance" style="color:var(--text-muted)">🏁 Final destination</div>`;

    return `<li class="stop-item" draggable="true" data-index="${i}">
      <div class="stop-number ${type}">${i + 1}</div>
      <div class="stop-details">
        <div class="stop-name" data-index="${i}" title="Click to rename">${escHtml(s.name || 'Stop ' + (i+1))}</div>
        <div class="stop-coords">${s.lat.toFixed(4)}°, ${s.lng.toFixed(4)}°</div>
        ${distRow}
      </div>
      <button class="stop-remove" data-index="${i}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </li>`;
  }).join('');

  // Drag-and-drop
  list.querySelectorAll('.stop-item').forEach(attachDragListeners);

  // Remove
  list.querySelectorAll('.stop-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeStop(+btn.dataset.index);
    });
  });

  // Click to pan
  list.querySelectorAll('.stop-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.stop-remove') || e.target.closest('.stop-name')) return;
      const idx = +item.dataset.index;
      map.panTo([stops[idx].lat, stops[idx].lng]);
      stops[idx].marker.openPopup();
    });
  });

  // ③ Click stop name to rename inline
  list.querySelectorAll('.stop-name').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const idx  = +el.dataset.index;
      const stop = stops[idx];
      const old  = stop.name || '';
      const newName = prompt(`Rename "${old || 'Stop ' + (idx + 1)}":`, old);
      if (newName === null) return;
      stop.name = newName.trim() || `Stop ${idx + 1}`;
      refreshRoute();
      fetchElevations();
    });
  });
}

function updateSummary(totalKm, legDurations = []) {
  document.getElementById('total-distance').textContent = stops.length > 1 ? fmtKm(totalKm) : '— km';
  document.getElementById('total-stops').textContent    = stops.length;

  if (stops.length > 1) {
    if (legDurations.length > 0) {
      // Use actual Directions API durations
      const totalSec = legDurations.reduce((a, b) => a + b, 0);
      document.getElementById('time-car').textContent  = fmtTime(totalSec / 3600);
      document.getElementById('time-walk').textContent = fmtTime((totalKm / WALK_KMH));
    } else {
      document.getElementById('time-car').textContent  = fmtTime(totalKm / CAR_KMH);
      document.getElementById('time-walk').textContent = fmtTime(totalKm / WALK_KMH);
    }
  } else {
    document.getElementById('time-car').textContent  = '—';
    document.getElementById('time-walk').textContent = '—';
  }
}

function updateRoutingBadge(mode) {
  document.getElementById('routing-badge-text').textContent =
    mode === 'road' ? 'Road distances (Mapbox)' : 'Direct-line distances';
}

function updateUndoClear() {
  document.getElementById('btn-undo').disabled  = stops.length === 0;
  document.getElementById('btn-clear').disabled = stops.length === 0;
  document.getElementById('btn-optimize').disabled = stops.length < 3;
  document.getElementById('btn-share').disabled = stops.length === 0;
}

// ═══════════════════════════════════════════════════════════════
// 11. ① GEOCODING SEARCH
// ═══════════════════════════════════════════════════════════════
const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchClear   = document.getElementById('search-clear');

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.style.display = q ? 'flex' : 'none';
  clearTimeout(searchDebounce);
  if (q.length < 2) { closeSearchResults(); return; }
  searchDebounce = setTimeout(() => doGeocode(q), 350);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSearchResults(); searchInput.blur(); }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.style.display = 'none';
  closeSearchResults();
  searchInput.focus();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-bar-wrap')) closeSearchResults();
});

async function doGeocode(query) {
  searchResults.innerHTML = '<li class="search-result-item loading">Searching…</li>';
  searchResults.classList.add('open');

  try {
    let places = [];

    if (HAS_MAPBOX) {
      // Mapbox Geocoding API
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=6&access_token=${MAPBOX_TOKEN}`;
      const data = await fetch(url).then(r => r.json());
      places = (data.features || []).map(f => ({
        name:    f.text,
        display: f.place_name,
        lat:     f.center[1],
        lng:     f.center[0],
      }));
    } else {
      // Nominatim (OSM) fallback — free, no key required
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1`;
      const data = await fetch(url, { headers: { 'Accept-Language': 'en' } }).then(r => r.json());
      places = (data || []).map(f => ({
        name:    f.display_name.split(',')[0],
        display: f.display_name,
        lat:     parseFloat(f.lat),
        lng:     parseFloat(f.lon),
      }));
    }

    if (places.length === 0) {
      searchResults.innerHTML = '<li class="search-result-item loading">No results found</li>';
      return;
    }

    searchResults.innerHTML = places.map((p, i) => `
      <li class="search-result-item" data-i="${i}" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${escHtmlAttr(p.name)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        <div>
          <div class="sri-name">${escHtml(p.name)}</div>
          <div class="sri-sub">${escHtml(p.display)}</div>
        </div>
      </li>
    `).join('');

    searchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat  = parseFloat(item.dataset.lat);
        const lng  = parseFloat(item.dataset.lng);
        const name = item.dataset.name;
        closeSearchResults();
        searchInput.value = '';
        searchClear.style.display = 'none';
        map.setView([lat, lng], 13, { animate: true });
        openLabelModal(lat, lng, name);
      });
    });

  } catch (err) {
    console.error('Geocode error:', err);
    searchResults.innerHTML = '<li class="search-result-item loading">Search failed</li>';
  }
}

function closeSearchResults() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════
// 12. ② ELEVATION PROFILE
// ═══════════════════════════════════════════════════════════════

async function fetchElevations() {
  if (stops.length < 2) { hideElevation(); return; }

  // Collect sample points along the route (up to 100 total)
  const samples = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const steps = Math.max(3, Math.min(20, Math.ceil(stops.length > 8 ? 5 : 12)));
    for (let t = 0; t <= steps; t++) {
      const frac = t / steps;
      samples.push({
        lat:   stops[i].lat + frac * (stops[i+1].lat - stops[i].lat),
        lng:   stops[i].lng + frac * (stops[i+1].lng - stops[i].lng),
        segIdx: i,
        frac,
      });
    }
  }

  try {
    // Open-Elevation API — free, no key
    const body = { locations: samples.map(s => ({ latitude: s.lat, longitude: s.lng })) };
    const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!resp.ok) throw new Error('Elevation API error');
    const data      = await resp.json();
    const elevs     = data.results.map(r => r.elevation);
    const labels    = samples.map((s, i) => {
      const seg    = stops[s.segIdx];
      const nxt    = stops[s.segIdx + 1];
      const dist   = haversineKm(seg.lat, seg.lng, nxt.lat, nxt.lng);
      return `${s.segIdx + 1}→${s.segIdx + 2} (${(s.frac * dist).toFixed(1)} km)`;
    });

    const minE = Math.min(...elevs), maxE = Math.max(...elevs);
    document.getElementById('elevation-range').textContent =
      `${minE.toFixed(0)} m – ${maxE.toFixed(0)} m`;

    renderElevationChart(labels, elevs);
    document.getElementById('elevation-panel').style.display = 'block';

  } catch (err) {
    console.warn('Elevation fetch failed:', err);
    // Silently hide — not a critical failure
    hideElevation();
  }
}

function renderElevationChart(labels, data) {
  const canvas = document.getElementById('elevation-chart');
  const ctx    = canvas.getContext('2d');

  if (elevationChart) elevationChart.destroy();

  const isDark  = document.body.classList.contains('dark-mode');
  const accent  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const textCol = isDark ? '#8a8579' : '#7c776e';

  elevationChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor:     accent || '#c9602b',
        backgroundColor: (context) => {
          const chart = context.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'transparent';
          const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          grad.addColorStop(0, 'rgba(201,96,43,.35)');
          grad.addColorStop(1, 'rgba(201,96,43,.0)');
          return grad;
        },
        borderWidth:   2,
        pointRadius:   0,
        tension:       0.3,
        fill:          true,
      }],
    },
    options: {
      animation: { duration: 600 },
      responsive:          true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          display:   true,
          ticks:     { color: textCol, font: { size: 9 }, maxTicksLimit: 4,
                       callback: v => `${v} m` },
          grid:      { color: isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)' },
          border:    { display: false },
        },
      },
    },
  });
}

function hideElevation() {
  document.getElementById('elevation-panel').style.display = 'none';
  if (elevationChart) { elevationChart.destroy(); elevationChart = null; }
}

// ═══════════════════════════════════════════════════════════════
// 13. ④ ROUTE OPTIMIZATION — TSP Nearest-Neighbor
// ═══════════════════════════════════════════════════════════════

/**
 * Classic greedy nearest-neighbor TSP heuristic.
 * Keeps the first stop fixed as the start.
 * Time complexity: O(n²) — perfectly fine for ≤ 50 stops.
 *
 * Returns a new stops array in optimized order.
 */
function tspNearestNeighbor(stopsArr) {
  if (stopsArr.length < 3) return stopsArr;

  const unvisited = stopsArr.slice(1); // keep stop[0] as anchor
  const tour      = [stopsArr[0]];

  while (unvisited.length > 0) {
    const last = tour[tour.length - 1];
    let   bestIdx = 0;
    let   bestDist = Infinity;

    unvisited.forEach((s, i) => {
      const d = haversineKm(last.lat, last.lng, s.lat, s.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });

    tour.push(unvisited.splice(bestIdx, 1)[0]);
  }

  return tour;
}

document.getElementById('btn-optimize').addEventListener('click', () => {
  if (stops.length < 3) return;
  const before = calcTotalKm();
  const optimized = tspNearestNeighbor([...stops]);

  // Remove old markers, re-add in order
  stops.forEach(s => map.removeLayer(s.marker));
  stops = optimized;
  stops.forEach((s, i) => {
    const type = i === 0 ? 'first' : i === stops.length - 1 ? 'last' : 'mid';
    s.marker = L.marker([s.lat, s.lng], { icon: makeIcon(s.name || i + 1, type) })
      .addTo(map)
      .bindPopup(makePopupHTML(s, i + 1));
    s.marker.on('click', () => s.marker.openPopup());
  });

  const after = calcTotalKm();
  const saved = before - after;
  refreshRoute();
  fetchElevations();
  showToast(`✨ Optimized! Saved ~${fmtKm(saved)} (${fmtKm(before)} → ${fmtKm(after)})`, 4000);
});

// ═══════════════════════════════════════════════════════════════
// 14. ⑤ URL SHARING
// ═══════════════════════════════════════════════════════════════

/**
 * Encode stops to a compact base64 JSON and store in URL hash.
 * URL example:  …/index.html#route=eyJzIjpb...
 */
function encodeRouteToHash() {
  const payload = stops.map(s => ({
    a: +s.lat.toFixed(5),
    o: +s.lng.toFixed(5),
    n: s.name || '',
  }));
  const json   = JSON.stringify(payload);
  const b64    = btoa(unescape(encodeURIComponent(json)));
  return `#route=${b64}`;
}

function decodeRouteFromHash(hash) {
  try {
    const match = hash.match(/^#route=(.+)$/);
    if (!match) return null;
    const json = decodeURIComponent(escape(atob(match[1])));
    return JSON.parse(json);
  } catch { return null; }
}

document.getElementById('btn-share').addEventListener('click', () => {
  if (stops.length === 0) return;
  const hash = encodeRouteToHash();
  const url  = `${location.origin}${location.pathname}${location.search}${hash}`;
  navigator.clipboard.writeText(url)
    .then(() => showToast('🔗 Shareable link copied to clipboard!', 3000))
    .catch(() => {
      prompt('Copy this link:', url);
    });
  history.replaceState(null, '', hash);
});

function loadRouteFromHash() {
  const decoded = decodeRouteFromHash(location.hash);
  if (!decoded || !Array.isArray(decoded) || decoded.length === 0) return;
  decoded.forEach(({ a: lat, o: lng, n: name }) => {
    commitStop(lat, lng, name || `Stop ${stops.length + 1}`);
  });
  if (stops.length > 1) {
    const bounds = L.latLngBounds(stops.map(s => [s.lat, s.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }
  showToast(`🗺️ Loaded ${stops.length} stops from shared link`, 3500);
}

// ═══════════════════════════════════════════════════════════════
// 15. ⑥ ROUTING MODE TOGGLE
// ═══════════════════════════════════════════════════════════════
document.getElementById('btn-routing-road').addEventListener('click', () => {
  if (!HAS_MAPBOX) {
    showToast('🗝️ Road routing requires a Mapbox token — add it to script.js', 4500);
    return;
  }
  routingMode = 'road';
  document.getElementById('btn-routing-road').classList.add('active');
  document.getElementById('btn-routing-straight').classList.remove('active');
  refreshRoute();
});

document.getElementById('btn-routing-straight').addEventListener('click', () => {
  routingMode = 'straight';
  document.getElementById('btn-routing-straight').classList.add('active');
  document.getElementById('btn-routing-road').classList.remove('active');
  refreshRoute();
});

// ═══════════════════════════════════════════════════════════════
// 16. DRAG-AND-DROP REORDER
// ═══════════════════════════════════════════════════════════════
function attachDragListeners(item) {
  item.addEventListener('dragstart', e => {
    dragSrcIdx = +item.dataset.index;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('drag-over'));
    dragSrcIdx = null;
  });

  item.addEventListener('dragover', e => {
    e.preventDefault();
    item.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  });

  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

  item.addEventListener('drop', e => {
    e.preventDefault();
    const destIdx = +item.dataset.index;
    if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
    const [moved] = stops.splice(dragSrcIdx, 1);
    stops.splice(destIdx, 0, moved);
    refreshRoute();
    fetchElevations();
    showToast('Stop reordered');
  });
}

// ═══════════════════════════════════════════════════════════════
// 17. TOOLBAR ACTIONS
// ═══════════════════════════════════════════════════════════════

// Undo
document.getElementById('btn-undo').addEventListener('click', () => {
  if (!stops.length) return;
  removeStop(stops.length - 1);
  showToast('Last stop removed');
});

// Clear
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!stops.length) return;
  if (!confirm('Clear all stops and reset the route?')) return;
  stops.forEach(s => map.removeLayer(s.marker));
  polylines.forEach(p => map.removeLayer(p));
  stops = []; polylines = [];
  hideElevation();
  history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('map-hint').classList.remove('hidden');
  refreshRoute();
  showToast('Route cleared');
});

// Export
document.getElementById('btn-export').addEventListener('click', () => {
  if (!stops.length) { showToast('No stops to export'); return; }
  const data = {
    version:  '2.0',
    exported: new Date().toISOString(),
    totalKm:  calcTotalKm(),
    stops:    stops.map((s, i) => ({ index: i + 1, lat: s.lat, lng: s.lng, name: s.name })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `voyagr-route-${Date.now()}.json`,
  });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${stops.length} stops`);
});

// Import
document.getElementById('input-import').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ({ target: { result } }) => {
    try {
      const data = JSON.parse(result);
      if (!Array.isArray(data.stops)) throw new Error('bad format');
      stops.forEach(s => map.removeLayer(s.marker));
      polylines.forEach(p => map.removeLayer(p));
      stops = []; polylines = [];
      data.stops.forEach(({ lat, lng, name }) => commitStop(lat, lng, name || `Stop ${stops.length + 1}`));
      if (stops.length > 1) {
        map.fitBounds(L.latLngBounds(stops.map(s => [s.lat, s.lng])), { padding: [40, 40] });
      }
      showToast(`Imported ${stops.length} stops`);
    } catch { showToast('❌ Invalid file — is it a Voyagr JSON?', 4000); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Dark/light mode
document.getElementById('btn-theme').addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark-mode');
  document.body.classList.toggle('light-mode', !isDark);
  // Re-render elevation chart in new theme
  if (elevationChart && stops.length > 1) fetchElevations();
  showToast(isDark ? '🌙 Dark mode on' : '☀️ Light mode on');
});

// ═══════════════════════════════════════════════════════════════
// 18. UTILITIES
// ═══════════════════════════════════════════════════════════════
function calcTotalKm() {
  let t = 0;
  for (let i = 0; i < stops.length - 1; i++)
    t += haversineKm(stops[i].lat, stops[i].lng, stops[i+1].lat, stops[i+1].lng);
  return t;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escHtmlAttr(s) { return escHtml(s); }

let toastTimer = null;
function showToast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ═══════════════════════════════════════════════════════════════
// 19. INIT
// ═══════════════════════════════════════════════════════════════
updateUndoClear();
updateSummary(0);

// Load route from URL hash if present (⑤ sharing)
if (location.hash.startsWith('#route=')) {
  setTimeout(loadRouteFromHash, 200); // slight delay for map to fully init
}
