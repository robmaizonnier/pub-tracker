/* ============= settings ============= */
const DWELL_MINUTES = 30;    // stay ≥ N minutes to count
const RADIUS_METRES  = 15;  // max distance from pub
const CHUNK_SIZE     = 500; // sessions processed before UI update
/* ==================================== */

const METRES_PER_DEG_LAT = 111_320;
function metresPerDegLon(lat) {
  return METRES_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}
function dist2(lat1, lon1, lat2, lon2) {
  const dx = (lon1 - lon2) * metresPerDegLon(lat1);
  const dy = (lat1 - lat2) * METRES_PER_DEG_LAT;
  return dx * dx + dy * dy;
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
      id  : f.id,
      lat : f.geometry.coordinates[1],
      lon : f.geometry.coordinates[0],
      name: tags.name || f.properties?.name || "Unnamed pub",
      postcode: tags["addr:postcode"] ||
                f.properties?.["addr:postcode"] || ""
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
  resultEl.style.whiteSpace = "pre-wrap";   // ★ preserve \n as real line-breaks

  /* progress bar */
  const prog = document.createElement("progress");
  prog.max = 1;
  prog.value = 0;
  resultEl.before(prog);

  /* choose file */
  const file = document.getElementById("timelineFile").files[0];
  if (!file) { alert("Choose a JSON file"); prog.remove(); return; }

  /* parse JSON */
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { alert("Invalid JSON"); prog.remove(); return; }

  /* normalise -> sessions */
  const sessions = [];
  if (json.timelineObjects) {
    json.timelineObjects.forEach(o => {
      if (o.placeVisit?.duration && o.placeVisit.location) {
        addSession(
          sessions,
          o.placeVisit.location.latitudeE7  / 1e7,
          o.placeVisit.location.longitudeE7 / 1e7,
          +o.placeVisit.duration.startTimestampMs,
          +o.placeVisit.duration.endTimestampMs
        );
      }
    });
  } else if (json.locations) {
    json.locations.forEach(l => addSession(
      sessions,
      l.latitudeE7  / 1e7,
      l.longitudeE7 / 1e7,
      +l.timestampMs,
      +l.timestampMs
    ));
  } else if (json.semanticSegments) {
    json.semanticSegments.forEach(seg => {
      if (seg.segmentType === "TYPE_PLACE" && seg.placeVisit) {
        addSession(
          sessions,
          seg.placeVisit.location.latitudeE7  / 1e7,
          seg.placeVisit.location.longitudeE7 / 1e7,
          +seg.placeVisit.duration.startTimestampMs,
          +seg.placeVisit.duration.endTimestampMs
        );
      }
    });
  } else if (Array.isArray(json) && json[0]?.visit) { // visit-list
    json.forEach(v => {
      const locStr = v.visit?.topCandidate?.placeLocation;
      const m = /^geo:([-0-9.]+),([-0-9.]+)$/.exec(locStr || "");
      if (!m) return;
      addSession(
        sessions,
        parseFloat(m[1]),
        parseFloat(m[2]),
        Date.parse(v.startTime),
        Date.parse(v.endTime)
      );
    });
  } else {
    alert("Unrecognised JSON schema");
    prog.remove();
    return;
  }

  if (!sessions.length) { resultEl.textContent = "No usable points."; prog.remove(); return; }

  /* load pubs */
  let pubs;
  try { pubs = await loadPubs(); }
  catch { resultEl.textContent = "Failed to load pub list."; prog.remove(); return; }

  const pubById = Object.fromEntries(pubs.map(p => [p.id, p]));
  const dwellMs = DWELL_MINUTES * 60_000;
  const radius2 = RADIUS_METRES * RADIUS_METRES;

  /* analytics */
  const visitCounts = new Map();    // pubId → total visits
  const firstVisit  = new Map();    // pubId → first visit timestamp
  const lastVisit   = new Map();    // pubId → last visit timestamp
  const visitsThisYear = [];        // {pubId, ts, firstInYear}
  const nowYear = new Date().getUTCFullYear();

  /* progress setup */
  prog.max = Math.ceil(sessions.length / CHUNK_SIZE);
  prog.value = 0;

  /* crunch sessions */
  for (let i = 0; i < sessions.length; i += CHUNK_SIZE) {
    const slice = sessions.slice(i, i + CHUNK_SIZE);

    slice.forEach(s => {
      if (s.end - s.start < dwellMs) return;
      for (const pub of pubs) {
        if (dist2(s.lat, s.lon, pub.lat, pub.lon) < radius2) {
          const ts  = s.start;
          const yr  = new Date(ts).getUTCFullYear();

          visitCounts.set(pub.id, (visitCounts.get(pub.id) || 0) + 1);
          lastVisit.set(pub.id, Math.max(lastVisit.get(pub.id) || 0, ts));

          const isFirstEver = !firstVisit.has(pub.id);
          if (isFirstEver) firstVisit.set(pub.id, ts);

          if (yr === nowYear) {
            visitsThisYear.push({ pubId: pub.id, ts, firstInYear: isFirstEver });
          }
          break;
        }
      }
    });

    prog.value += 1;
    await new Promise(requestAnimationFrame);
  }

  /* build outputs */
  const top10 = [...visitCounts.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10)
    .map(([id,n],i)=>{
      const p = pubById[id];
      const pc = p.postcode ? ` (${p.postcode})` : "";
      return ` ${i+1}. ${p.name}${pc} – ${n}`;
    });

  const yearLines = visitsThisYear
    .sort((a,b)=>a.ts-b.ts)
    .map(v => {
      const d = new Date(v.ts).toISOString().slice(0,10);
      const mark = v.firstInYear ? " [first time!]" : "";
      return `• ${pubById[v.pubId].name} – ${d}${mark}`;
    });

  const allTimeLines = [...visitCounts.entries()]
    .sort((a,b)=>b[1]-a[1])
    .map(([id,n])=>{
      const last = new Date(lastVisit.get(id)).toISOString().slice(0,10);
      const p = pubById[id];
      const pc = p.postcode ? ` (${p.postcode})` : "";
      return `${p.name}${pc} – ${n} (${last})`;
    });

  const txt =
    `📊 Percentage visited:\n` +
    `• ${firstVisit.size} of ${pubs.length} pubs = ${((firstVisit.size / pubs.length)*100).toFixed(2)}%\n\n` +
    `🍺 Top-10 pubs by visits:\n` + top10.join("\n") + "\n\n" +
    `📆 Pubs visited in ${nowYear}:\n` + (yearLines.length ? yearLines.join("\n") : " none") +
    "\n\n" +
    `📚 All-time pubs sorted by visits:\n` + allTimeLines.join("\n");

  resultEl.textContent = txt;
  prog.remove();
}

document.getElementById("goBtn").addEventListener("click", handleClick);
