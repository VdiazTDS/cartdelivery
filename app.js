window.addEventListener("error", e => {
  console.error("JS ERROR:", e.message, "at line", e.lineno);
});


// ================= SUPABASE CONFIG =================
// Connection info for cloud file storage
const SUPABASE_URL = "https://lffazhbwvorwxineklsy.supabase.co";
const SUPABASE_KEY = "sb_publishable_Lfh2zlIiTSMB0U-Fe5o6Jg_mJ1qkznh";
const BUCKET = "excel-files";

//======

document.addEventListener("DOMContentLoaded", () => {
  initApp();
});

//======


// Create Supabase client
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);


// ================= FILE NAME MATCHING =================
// Makes route files and route summary files match even if
// spacing, punctuation, or "RouteSummary" text is different.
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(".xlsx", "")
    .replace("route summary", "")   // handles "Route Summary"
    .replace("routesummary", "")    // handles "RouteSummary"
    .replace(/[_\s.-]/g, "")        // ignore spaces, _, ., -
    .trim();
}


// ================= MAP SETUP =================
// Create Leaflet map
const map = L.map("map").setView([0, 0], 2);

// Base map layers
const baseMaps = {
  streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  )
};

// Default map
baseMaps.streets.addTo(map);

// Dropdown to switch map type
document.getElementById("baseMapSelect").addEventListener("change", e => {
  Object.values(baseMaps).forEach(l => map.removeLayer(l));
  baseMaps[e.target.value].addTo(map);
});


// ================= MAP SYMBOL SETTINGS =================
const colors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"];
const shapes = ["circle","square","triangle","diamond"];

const symbolMap = {};        // stores symbol for each route/day combo
const routeDayGroups = {};   // stores map markers grouped by route/day
let symbolIndex = 0;
let globalBounds = L.latLngBounds(); // used to zoom map to all points


// Convert day number → day name
function dayName(n) {
  return ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][n-1];
}


// Assign a unique color/shape to each route/day
function getSymbol(key) {
  if (!symbolMap[key]) {
    symbolMap[key] = {
      color: colors[symbolIndex % colors.length],
      shape: shapes[Math.floor(symbolIndex / colors.length) % shapes.length]
    };
    symbolIndex++;
  }
  return symbolMap[key];
}


// Create marker with correct shape
function createMarker(lat, lon, symbol) {

  // Circle marker
  if (symbol.shape === "circle") {
    return L.circleMarker([lat, lon], {
      radius: 5,
      color: symbol.color,
      fillColor: symbol.color,
      fillOpacity: 0.9
    });
  }

  // Custom HTML shapes
  let html = "";

  if (symbol.shape === "square")
    html = `<div style="width:10px;height:10px;background:${symbol.color}"></div>`;

  if (symbol.shape === "triangle")
    html = `<div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:10px solid ${symbol.color}"></div>`;

  if (symbol.shape === "diamond")
    html = `<div style="width:10px;height:10px;background:${symbol.color};transform:rotate(45deg)"></div>`;

  return L.marker([lat, lon], { icon: L.divIcon({ html, className: "" }) });
}


// ================= FILTER CHECKBOX UI =================
function buildRouteCheckboxes(routes) {
  const c = document.getElementById("routeCheckboxes");
  c.innerHTML = "";

  routes.forEach(r => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${r}" checked> ${r}`;
    l.querySelector("input").addEventListener("change", applyFilters);
    c.appendChild(l);
  });
}

function buildDayCheckboxes() {
  const c = document.getElementById("dayCheckboxes");
  c.innerHTML = "";

  [1,2,3,4,5,6,7].forEach(d => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${d}" checked> ${dayName(d)}`;
    l.querySelector("input").addEventListener("change", applyFilters);
    c.appendChild(l);
  });
}
buildDayCheckboxes();


// Select/Deselect all checkboxes
function setCheckboxGroup(containerId, checked) {
  document.querySelectorAll(`#${containerId} input`).forEach(b => (b.checked = checked));
  applyFilters();
}

document.getElementById("routesAll").onclick  = () => setCheckboxGroup("routeCheckboxes", true);
document.getElementById("routesNone").onclick = () => setCheckboxGroup("routeCheckboxes", false);
document.getElementById("daysAll").onclick    = () => setCheckboxGroup("dayCheckboxes", true);
document.getElementById("daysNone").onclick   = () => setCheckboxGroup("dayCheckboxes", false);


// ================= APPLY MAP FILTERS =================
function applyFilters() {
  const routes = [...document.querySelectorAll("#routeCheckboxes input:checked")].map(i => i.value);
  const days   = [...document.querySelectorAll("#dayCheckboxes input:checked")].map(i => i.value);

  Object.entries(routeDayGroups).forEach(([key, group]) => {
    const [r, d] = key.split("|");
    const show = routes.includes(r) && days.includes(d);
    group.layers.forEach(l => show ? l.addTo(map) : map.removeLayer(l));
  });

  updateStats();
}


// ================= ROUTE STATISTICS =================
function updateStats() {
  const list = document.getElementById("statsList");
  list.innerHTML = "";

  Object.entries(routeDayGroups).forEach(([key, group]) => {
    const visible = group.layers.filter(l => map.hasLayer(l)).length;
    if (!visible) return;

    const [r,d] = key.split("|");
    const li = document.createElement("li");
    li.textContent = `Route ${r} – ${dayName(d)}: ${visible}`;
    list.appendChild(li);
  });
}


// ================= PROCESS ROUTE EXCEL =================
function processExcelBuffer(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  // Clear previous map data
  Object.values(routeDayGroups).forEach(g => g.layers.forEach(l => map.removeLayer(l)));
  Object.keys(routeDayGroups).forEach(k => delete routeDayGroups[k]);
  Object.keys(symbolMap).forEach(k => delete symbolMap[k]);
  symbolIndex = 0;
  globalBounds = L.latLngBounds();

  const routeSet = new Set();

  // Create markers
  rows.forEach(row => {
    const lat = Number(row.LATITUDE);
    const lon = Number(row.LONGITUDE);
    const route = String(row.NEWROUTE);
    const day = String(row.NEWDAY);

    if (!lat || !lon || !route || !day) return;

    const key = `${route}|${day}`;
    const symbol = getSymbol(key);

    if (!routeDayGroups[key]) routeDayGroups[key] = { layers: [] };

    const m = createMarker(lat, lon, symbol)
      .bindPopup(`Route ${route}<br>${dayName(day)}`)
      .addTo(map);

    routeDayGroups[key].layers.push(m);
    routeSet.add(route);
    globalBounds.extend([lat, lon]);
  });

  buildRouteCheckboxes([...routeSet]);
  applyFilters();
  map.fitBounds(globalBounds);
}


// ================= LIST FILES FROM CLOUD =================
async function listFiles() {
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) return console.error(error);

  const ul = document.getElementById("savedFiles");
  ul.innerHTML = "";

  const routeFiles = {};
  const summaryFiles = {};

 // Separate route files and summary files
data.forEach(file => {
  const name = file.name.toLowerCase();

  if (name.includes("routesummary")) {
    summaryFiles[normalizeName(name)] = file.name;
  } else {
    routeFiles[normalizeName(name)] = file.name;
  }
});


  // Build UI
  Object.keys(routeFiles).forEach(key => {
    const routeName = routeFiles[key];
    const summaryName = summaryFiles[key];

    const li = document.createElement("li");

    // OPEN MAP
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open Map";

    openBtn.onclick = async () => {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(routeName);
      const r = await fetch(data.publicUrl);
      processExcelBuffer(await r.arrayBuffer());

      loadSummaryFor(routeName);
    };

    li.appendChild(openBtn);

    // SUMMARY BUTTON
    if (summaryName) {
      const summaryBtn = document.createElement("button");
      summaryBtn.textContent = "Summary";
      summaryBtn.style.marginLeft = "5px";
      summaryBtn.onclick = () => loadSummaryFor(routeName);
      li.appendChild(summaryBtn);
    }

    // DELETE
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.style.marginLeft = "5px";

    delBtn.onclick = async () => {
      const toDelete = [routeName];
      if (summaryName) toDelete.push(summaryName);

      await sb.storage.from(BUCKET).remove(toDelete);
      listFiles();
    };

    li.appendChild(delBtn);
    li.appendChild(document.createTextNode(" " + routeName));
    ul.appendChild(li);
  });
}


// ================= UPLOAD FILE =================
async function uploadFile(file) {
  if (!file) return;

  const { error } = await sb.storage.from(BUCKET).upload(file.name, file, { upsert: true });

  if (error) {
    console.error("UPLOAD ERROR:", error);
    alert("Upload failed: " + error.message);
    return;
  }

  processExcelBuffer(await file.arrayBuffer());
  listFiles();
}


// ================= ROUTE SUMMARY DISPLAY =================
function showRouteSummary(rows, worksheet) {
  const tableBox = document.getElementById("routeSummaryTable");
  const panel = document.getElementById("bottomSummary");
  const btn = document.getElementById("summaryToggleBtn");

  if (!tableBox || !panel || !btn) return;

  tableBox.innerHTML = "";

  if (!rows || !rows.length) {
    tableBox.textContent = "No summary data found";
    return;
  }

  // ✅ Get headers EXACTLY in Excel order
  const headers = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0];

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");

  // ===== HEADER ROW =====
  const headerRow = document.createElement("tr");
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h ?? "";
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  // ===== DATA ROWS =====
  rows.forEach(r => {
    const tr = document.createElement("tr");

    headers.forEach(h => {
      const td = document.createElement("td");
      td.textContent = r[h] ?? "";
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  tableBox.appendChild(table);

  // ✅ AUTO-OPEN THE SUMMARY PANEL
  panel.classList.remove("collapsed");
  btn.textContent = "▼";
}



// Load matching summary file
async function loadSummaryFor(routeFileName) {
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) {
    console.error("LIST ERROR:", error);
    return;
  }

  console.log("ALL FILES:", data.map(f => f.name));
  console.log("ROUTE FILE CLICKED:", routeFileName);

  const normalizedRoute = normalizeName(routeFileName);
  console.log("NORMALIZED ROUTE:", normalizedRoute);

  const summary = data.find(f => {
    const lower = f.name.toLowerCase();
    const normalizedSummary = normalizeName(f.name);

    console.log("CHECKING:", f.name, "→", normalizedSummary);

    return (
      lower.includes("routesummary") ||
      lower.includes("route summary")
    ) && normalizedSummary === normalizedRoute;
  });

  console.log("FOUND SUMMARY:", summary);

  if (!summary) {
    document.getElementById("routeSummaryTable").textContent = "No summary available";
    return;
  }

  const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(summary.name);
  const r = await fetch(urlData.publicUrl);

  const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()), { type: "array" });
const ws = wb.Sheets[wb.SheetNames[0]];

const rows = XLSX.utils.sheet_to_json(ws);

showRouteSummary(rows, ws);

}



// ================= START APP =================
// ===== TOGGLE BOTTOM SUMMARY =====
function toggleSummary() {
  const panel = document.getElementById("bottomSummary");
  const btn = document.getElementById("summaryToggleBtn");

  panel.classList.toggle("collapsed");

  // flip arrow direction
  btn.textContent = panel.classList.contains("collapsed") ? "▲" : "▼";
}

function initApp() {

  // ===== BASE MAP DROPDOWN =====
  const baseSelect = document.getElementById("baseMapSelect");
  if (baseSelect) {
    baseSelect.addEventListener("change", e => {
      Object.values(baseMaps).forEach(l => map.removeLayer(l));
      baseMaps[e.target.value].addTo(map);
    });
  }

  // ===== SIDEBAR TOGGLE (DESKTOP) =====
  const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
  const sidebar = document.querySelector(".sidebar");
  const appContainer = document.querySelector(".app-container");

  if (toggleSidebarBtn && sidebar && appContainer) {
    toggleSidebarBtn.addEventListener("click", () => {
      appContainer.classList.toggle("collapsed");

      toggleSidebarBtn.textContent =
        appContainer.classList.contains("collapsed") ? "▶" : "◀";

      setTimeout(() => map.invalidateSize(), 200);
    });
  }

  // ===== MOBILE MENU =====
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");

  if (mobileMenuBtn && sidebar) {
    mobileMenuBtn.addEventListener("click", () => {
      const open = sidebar.classList.toggle("open");
      mobileMenuBtn.textContent = open ? "✕" : "☰";

      setTimeout(() => map.invalidateSize(), 200);
    });
  }
//========


  
  // ===== INITIAL DATA LOAD =====
  listFiles();

}
