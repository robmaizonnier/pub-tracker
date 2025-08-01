/* ============= settings ============= */
const DWELL_MINUTES    = 30;     // stay ≥ N minutes to count
const RADIUS_METRES    = 15;     // max distance from pub (for visit matching)
const CHUNK_SIZE       = 500;    // sessions processed per UI update
const HOME_LAT         = 51.554233;
const HOME_LON         = -0.054368815;
/* ==================================== */

const METRES_PER_DEG_LAT = 111_320;
function metresPerDegLon(lat) {
  return METRES_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}
function dist2(lat1, lon1, lat2, lon2) {
  const dx = (lon1 - lon2) * metresPerDegLon(lat1);
  const dy = (lat1 - lat2) * METRES_PER_DEG_LAT;
  return dx*dx + dy*dy;
}

/* -------------- pub list cache -------------- */
let PUBS = null;
async function loadPubs() {
  if (PUBS) return PUBS;
  const res = await fetch("pubs-gb.geojson");
  if (!res.ok) throw new Error("pub list not found");
  const gj = await res.json();
  PUBS = gj.features.map(f => {
    const tags = f.properties?.tags || {};
    return {
      id      : f.id,
      lat     : f.geometry.coordinates[1],
      lon     : f.geometry.coordinates[0],
      name    : tags.name || f.properties?.name || "Unnamed pub",
      postcode: (tags["addr:postcode"] || "").toUpperCase()
    };
  });
  return PUBS;
}
/* -------------------------------------------- */

function addSession(arr, lat, lon, start, end) {
  if (Number.isFinite(lat) && Number.isFinite(lon) && end > start) {
    arr.push({ lat, lon, start, end });
  }
}

async function handleClick() {
  const resultEl = document.getElementById("result");
  resultEl.textContent = "";

  // 1️⃣ Load & parse the file
  const file = document.getElementById("timelineFile").files[0];
  if (!file) { alert("Please select a JSON file"); return; }
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { alert("Invalid JSON"); return; }

  // 2️⃣ Build sessions
  const sessions = [];
  if (json.timelineObjects) {
    json.timelineObjects.forEach(o => {
      if (o.placeVisit?.duration && o.placeVisit.location) {
        addSession(
          sessions,
          o.placeVisit.location.latitudeE7/1e7,
          o.placeVisit.location.longitudeE7/1e7,
          +o.placeVisit.duration.startTimestampMs,
          +o.placeVisit.duration.endTimestampMs
        );
      }
    });
  } else if (json.locations) {
    json.locations.forEach(l => {
      addSession(
        sessions,
        l.latitudeE7/1e7, l.longitudeE7/1e7,
        +l.timestampMs, +l.timestampMs
      );
    });
  } else if (json.semanticSegments) {
    json.semanticSegments.forEach(seg => {
      const pv = seg.placeVisit;
      if (seg.segmentType==="TYPE_PLACE" && pv?.duration && pv.location) {
        addSession(
          sessions,
          pv.location.latitudeE7/1e7,
          pv.location.longitudeE7/1e7,
          +pv.duration.startTimestampMs,
          +pv.duration.endTimestampMs
        );
      }
    });
  } else if (Array.isArray(json) && json[0]?.visit) {
    json.forEach(v => {
      const m = /^geo:([-0-9.]+),([-0-9.]+)$/.exec(v.visit?.topCandidate?.placeLocation||"");
      if (m) addSession(
        sessions,
        +m[1], +m[2],
        Date.parse(v.startTime),
        Date.parse(v.endTime)
      );
    });
  } else {
    alert("Unrecognised JSON schema");
    return;
  }

  // 3️⃣ Load pubs
  const pubs = await loadPubs();
  const pubById = Object.fromEntries(pubs.map(p=>[p.id,p]));
  const dwellMs = DWELL_MINUTES*60_000;
  const radius2 = RADIUS_METRES*RADIUS_METRES;
  const nowYear = new Date().getUTCFullYear();

  // 4️⃣ Crunch visits
  const visitCounts = new Map(), firstVisit = new Map(), lastVisit = new Map();
  sessions.forEach(s => {
    if (s.end - s.start < dwellMs) return;
    for (const pub of pubs) {
      if (dist2(s.lat,s.lon,pub.lat,pub.lon) < radius2) {
        const ts = s.start;
        visitCounts.set(pub.id,(visitCounts.get(pub.id)||0)+1);
        lastVisit.set(pub.id,Math.max(lastVisit.get(pub.id)||0,ts));
        if (!firstVisit.has(pub.id)) firstVisit.set(pub.id,ts);
        break;
      }
    }
  });

  // 5️⃣ Initialize the Leaflet map (or clear an existing one)
  if (window._leafletMap) window._leafletMap.remove();
  window._leafletMap = L.map('map').setView([HOME_LAT,HOME_LON],12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap contributors'
  }).addTo(window._leafletMap);

  // 6️⃣ Add all pubs as circle-markers (red = visited, grey = not)
  pubs.forEach(pub => {
    const visited = firstVisit.has(pub.id);
    const color   = visited ? 'red' : 'grey';
    L.circleMarker([pub.lat,pub.lon], {
      radius: 6,
      fillColor: color,
      color: '#333',
      weight: 1,
      fillOpacity: 0.8
    })
      .addTo(window._leafletMap)
      .bindPopup(`${pub.name}${visited? ' (visited)' : ''}`);
  });

  // 7️⃣ Render the textual stats below
  const totalVisited = firstVisit.size,
        pctVisited   = ((totalVisited/pubs.length)*100).toFixed(2);

  let txt = `📊 Overall: ${totalVisited}/${pubs.length} pubs = ${pctVisited}% visited\n\n`;

  // …you can append top-10, 5-year summary, etc., here as before…

  resultEl.textContent = txt;
}

document.getElementById("goBtn").addEventListener("click", handleClick);

// wire up the dropZone to the hidden file input:
const dropZone = document.getElementById("dropZone"),
      fileIn   = document.getElementById("timelineFile");
dropZone.onclick = () => fileIn.click();
dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('hover'); };
dropZone.ondragleave = () => dropZone.classList.remove('hover');
dropZone.ondrop = e => {
  e.preventDefault();
  dropZone.classList.remove('hover');
  fileIn.files = e.dataTransfer.files;
  dropZone.textContent = fileIn.files[0].name;
};
