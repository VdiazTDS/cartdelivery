
// ================= SUPABASE CONFIG =================
const SUPABASE_URL = "https://lffazhbwvorwxineklsy.supabase.co";
const SUPABASE_KEY = "sb_publishable_Lfh2zlIiTSMB0U-Fe5o6Jg_mJ1qkznh";
const BUCKET = "excel-files";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

//========


function normalizeName(name) {
  return name
    .toLowerCase()
    .replace("route summary", "")
    .replace(/\s+/g, "")
    .replace(".xlsx", "")
    .trim();
}





// ================= MAP =================
const map = L.map("map").setView([0, 0], 2);

const baseMaps = {
  streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  )
};

baseMaps.streets.addTo(map);

document.getElementById("baseMapSelect").addEventListener("change", e => {
  Object.values(baseMaps).forEach(l => map.removeLayer(l));
  baseMaps[e.target.value].addTo(map);
});


// ================= DATA =================
const colors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"];
const shapes = ["circle","square","triangle","diamond"];
const symbolMap = {};
const routeDayGroups = {};
let symbolIndex = 0;
let globalBounds = L.latLngBounds();

function dayName(n) {
  return ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][n-1];
}

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

function createMarker(lat, lon, symbol) {
  if (symbol.shape === "circle") {
    return L.circleMarker([lat, lon], {
      radius: 5,
      color: symbol.color,
      fillColor: symbol.color,
      fillOpacity: 0.9
    });
  }

  let html = "";
  if (symbol.shape === "square")
    html = `<div style="width:10px;height:10px;background:${symbol.color}"></div>`;
  if (symbol.shape === "triangle")
    html = `<div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:10px solid ${symbol.color}"></div>`;
  if (symbol.shape === "diamond")
    html = `<div style="width:10px;height:10px;background:${symbol.color};transform:rotate(45deg)"></div>`;

  return L.marker([lat, lon], { icon: L.divIcon({ html, className: "" }) });
}


// ================= FILTER UI =================
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

function setCheckboxGroup(containerId, checked) {
  document.querySelectorAll(`#${containerId} input`).forEach(b => (b.checked = checked));
  applyFilters();
}

document.getElementById("routesAll").onclick  = () => setCheckboxGroup("routeCheckboxes", true);
document.getElementById("routesNone").onclick = () => setCheckboxGroup("routeCheckboxes", false);
document.getElementById("daysAll").onclick    = () => setCheckboxGroup("dayCheckboxes", true);
document.getElementById("daysNone").onclick   = () => setCheckboxGroup("dayCheckboxes", false);


// ================= FILTER =================
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


// ================= STATS =================
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


// ================= EXCEL PROCESS =================
function processExcelBuffer(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  Object.values(routeDayGroups).forEach(g => g.layers.forEach(l => map.removeLayer(l)));
  Object.keys(routeDayGroups).forEach(k => delete routeDayGroups[k]);
  Object.keys(symbolMap).forEach(k => delete symbolMap[k]);
  symbolIndex = 0;
  globalBounds = L.latLngBounds();

  const routeSet = new Set();

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


// ================= SUPABASE FILE LIST =================
async function listFiles() {
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) return console.error(error);

  const ul = document.getElementById("savedFiles");
  ul.innerHTML = "";

  const routeFiles = {};
  const summaryFiles = {};

  // Categorize files
  data.forEach(file => {
    const name = file.name.toLowerCase();

    if (name.includes("route summary")) {
      summaryFiles[normalizeName(name)] = file.name;
    } else {
      routeFiles[normalizeName(name)] = file.name;
    }
  });

  // Build UI rows
  Object.keys(routeFiles).forEach(key => {
    const routeName = routeFiles[key];
    const summaryName = summaryFiles[key];

    const li = document.createElement("li");

    // OPEN MAP BUTTON
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open Map";

    openBtn.onclick = async () => {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(routeName);
      const r = await fetch(data.publicUrl);
      processExcelBuffer(await r.arrayBuffer());

      // Load matching summary if it exists
      loadSummaryFor(routeName);
    };

    li.appendChild(openBtn);

    // SUMMARY BUTTON (optional)
    if (summaryName) {
      const summaryBtn = document.createElement("button");
      summaryBtn.textContent = "Summary";
      summaryBtn.style.marginLeft = "5px";

      summaryBtn.onclick = () => loadSummaryFor(routeName);

      li.appendChild(summaryBtn);
    }

    // DELETE BUTTON
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



// ================= UPLOAD =================
async function uploadFile(file) {
  if (!file) return;

  await sb.storage.from(BUCKET).upload(file.name, file, { upsert: true });

  processExcelBuffer(await file.arrayBuffer());
  listFiles();
}


// ================= INPUT =================
const dropZone = document.getElementById("dropZone");
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".xlsx,.xls";

dropZone.onclick = () => fileInput.click();
dropZone.ondragover = e => e.preventDefault();
dropZone.ondrop = e => {
  e.preventDefault();
  uploadFile(e.dataTransfer.files[0]);
};

fileInput.onchange = e => uploadFile(e.target.files[0]);


// ================= SIDEBAR / MOBILE =================
const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
const sidebar = document.querySelector(".sidebar");

mobileMenuBtn.onclick = () => {
  const isOpen = sidebar.classList.toggle("open");
  mobileMenuBtn.textContent = isOpen ? "✕" : "☰";
  setTimeout(() => map.invalidateSize(), 200);
};

toggleSidebarBtn.onclick = () => {
  if (window.innerWidth <= 900) {
    sidebar.classList.toggle("open");
  } else {
    document.querySelector(".app-container").classList.toggle("collapsed");
    toggleSidebarBtn.textContent =
      document.querySelector(".app-container").classList.contains("collapsed") ? "▶" : "◀";
  }
  setTimeout(() => map.invalidateSize(), 200);
};

function findColumn(row, keywords) {
  const keys = Object.keys(row);

  for (const k of keys) {
    const lower = k.toLowerCase();
    if (keywords.some(word => lower.includes(word))) {
      return k;
    }
  }
  return null;
}

function showRouteSummary(rows) {
  const box = document.getElementById("routeSummary");
  box.innerHTML = "";

  if (!rows.length) {
    box.textContent = "No summary data found";
    return;
  }
async function loadSummaryFor(routeFileName) {
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) return;

  const normalizedRoute = normalizeName(routeFileName);

  const summary = data.find(f =>
    f.name.toLowerCase().includes("route summary") &&
    normalizeName(f.name) === normalizedRoute
  );

  if (!summary) {
    document.getElementById("routeSummary").textContent = "No summary available";
    return;
  }

  try {
    const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(summary.name);
    const r = await fetch(urlData.publicUrl);

    const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

    showRouteSummary(rows);
  } catch {
    document.getElementById("routeSummary").textContent = "No summary available";
  }
}

  // Detect columns from first row
  const sample = rows[0];

  const routeCol    = findColumn(sample, ["route"]);
  const stopsCol    = findColumn(sample, ["stop", "seq", "count"]);
  const distCol     = findColumn(sample, ["dist", "mile"]);
  const timeCol     = findColumn(sample, ["time", "hour", "total"]);

  rows.forEach(r => {
    const div = document.createElement("div");
    div.style.marginBottom = "10px";

    div.innerHTML = `
      <strong>${routeCol ? `Route ${r[routeCol]}` : "Route"}</strong><br>
      Stops: ${stopsCol ? r[stopsCol] : "-"}<br>
      Distance: ${distCol ? r[distCol] : "-"}<br>
      Total Time: ${timeCol ? r[timeCol] : "-"}
    `;

    box.appendChild(div);
  });
}




  const { data } = sb.storage.from(BUCKET).getPublicUrl(summaryName);

  try {
    const r = await fetch(data.publicUrl);
    if (!r.ok) throw new Error("No summary");

    const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

    showRouteSummary(rows);
  } catch {
    document.getElementById("routeSummary").textContent = "No summary available";
  }
}





listFiles();
