window.addEventListener("error", e => {
  console.error("JS ERROR:", e.message, "at line", e.lineno);
});

let layerVisibilityState = {};

// ================= SUPABASE CONFIG =================
// Connection info for cloud file storage
const SUPABASE_URL = "https://lffazhbwvorwxineklsy.supabase.co";
const SUPABASE_KEY = "sb_publishable_Lfh2zlIiTSMB0U-Fe5o6Jg_mJ1qkznh";
const BUCKET = "excel-files";
// ===== CURRENT EXCEL STATE =====
window._currentRows = null;
window._currentWorkbook = null;
window._currentFilePath = null;

window.streetLabelsEnabled = true;

//======
// 🔐 Delete protection password
const DELETE_PASSWORD = "Austin1";  // ← change to whatever you want




document.addEventListener("DOMContentLoaded", () => {
  initApp();
  document.addEventListener("DOMContentLoaded", initApp);


// ================= SUN MODE TOGGLE =================

const sunToggle = document.getElementById("sunModeToggle");

// Load saved preference
if (localStorage.getItem("sunMode") === "on") {
  document.body.classList.add("sun-mode");
  if (sunToggle) sunToggle.checked = true;
}

if (sunToggle) {
  sunToggle.addEventListener("change", () => {
    if (sunToggle.checked) {
      document.body.classList.add("sun-mode");
      localStorage.setItem("sunMode", "on");
    } else {
      document.body.classList.remove("sun-mode");
      localStorage.setItem("sunMode", "off");
    }
  });
}

  });
/* ⭐ Ensures mobile buttons move AFTER full page load */
window.addEventListener("load", placeLocateButton);

// ===== USER GEOLOCATION =====
function locateUser() {
  if (!navigator.geolocation) {
    console.warn("Geolocation not supported");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // Center map on user
      map.setView([lat, lon], 14);
    },
    err => {
      console.warn("Location permission denied or unavailable");
      map.setView([39.5, -98.35], 4);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000
    }
  );
}

// ===== FLOATING "CENTER ON ME" BUTTON =====
let watchId = null;
let userCircle = null;



function startLiveTracking() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported on this device.");
    return;
  }

  // Stop previous tracking
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

// Start compass tracking first
startHeadingTracking();

watchId = navigator.geolocation.watchPosition(
  (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    const latlng = [lat, lng];

    // ===== Heading Arrow =====
    if (!headingMarker) {
      headingMarker = L.marker(latlng, {
        icon: createHeadingIcon(currentHeading),
        interactive: false
      }).addTo(map);
    } else {
      headingMarker.setLatLng(latlng);
    }

    // Smooth follow
    map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 1.2 });

   

    // ===== Accuracy circle =====
    if (!userCircle) {
      userCircle = L.circle(latlng, {
        radius: accuracy,
        color: "#2a93ff",
        fillColor: "#2a93ff",
        fillOpacity: 0.2,
        weight: 2,
      }).addTo(map);
    } else {
      userCircle.setLatLng(latlng);
      userCircle.setRadius(accuracy);
    }
  },
  (err) => {
    console.error("GPS error:", err);
    alert("Unable to get your location.");
  },
  {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000,
  }
);

}


//===direction user is facing
let headingMarker = null;
let currentHeading = 0;

function createHeadingIcon(angle) {
  return L.divIcon({
    className: "heading-icon-modern",
    html: `
      <div style="
        transform: rotate(${angle}deg);
        transition: transform 0.12s linear;
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <svg width="36" height="36" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="14" fill="rgba(66,165,245,0.15)" />
          <circle cx="18" cy="18" r="10" fill="#ffffff" />
          <path d="M18 6 L24 22 L18 19 L12 22 Z" fill="#42a5f5"/>
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}





function startHeadingTracking() {
  if (typeof DeviceOrientationEvent !== "undefined") {

    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then(permissionState => {
          if (permissionState === "granted") {
            window.addEventListener("deviceorientation", updateHeading);
          }
        })
        .catch(console.error);
    } else {
      window.addEventListener("deviceorientation", updateHeading);
    }

  }
}




function updateHeading(event) {
  if (event.alpha === null) return;

  currentHeading = 360 - event.alpha; // Convert to compass style

  if (headingMarker) {
    headingMarker.setIcon(createHeadingIcon(currentHeading));
  }
}



// ===== HARD REFRESH BUTTON (SAFE + NO CACHE) =====
const hardRefreshBtn = document.getElementById("hardRefreshBtn");

if (hardRefreshBtn) {
  let refreshArmed = false;

  hardRefreshBtn.addEventListener("click", () => {

    // Mobile double-tap protection
    if (window.innerWidth <= 900) {
      if (!refreshArmed) {
        refreshArmed = true;
        hardRefreshBtn.textContent = "Tap again to refresh";

        setTimeout(() => {
          refreshArmed = false;
          hardRefreshBtn.textContent = "Refresh";
        }, 2000);

        return;
      }
    }

    // Clear cache storage if supported
    if ("caches" in window) {
      caches.keys().then(names => names.forEach(n => caches.delete(n)));
    }

    // True hard reload (no cache)
    window.location.href = window.location.pathname + "?v=" + Date.now();
  });
}


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
// Shared Canvas renderer for high-performance drawing
const canvasRenderer = L.canvas({ padding: 0.5 });


// ===== BASE MAP LAYERS =====
const baseMaps = {
  streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  )
};

// ===== SATELLITE STREET NAME OVERLAY (LIGHTWEIGHT) =====
const satelliteLabelsLayer = L.tileLayer(
  "https://tiles.stadiamaps.com/tiles/alidade_smooth_labels/{z}/{x}/{y}{r}.png",
  {
    maxZoom: 20,
    opacity: window.innerWidth <= 900 ? 0.7 : 0.9,
    updateWhenIdle: true,
    keepBuffer: 2
  }
);
//======

// ================= POLYGON SELECT =================


// when polygon created
// ================= POLYGON SELECT =================
let drawnLayer = new L.FeatureGroup();
map.addLayer(drawnLayer);

const drawControl = new L.Control.Draw({
  draw: {
    polygon: true,
    rectangle: true,
    circle: false,
    marker: false,
    polyline: false,
    circlemarker: false
  },
  edit: { featureGroup: drawnLayer }
});

map.addControl(drawControl);

// ===== SELECTION COUNT FUNCTION (GLOBAL & CORRECT) =====
function updateSelectionCount() {
const polygon = drawnLayer.getLayers()[0];
let count = 0;

Object.entries(routeDayGroups).forEach(([key, group]) => {
 group.layers.forEach(marker => {
   const base = marker._base;
   if (!base) return;

   const latlng = L.latLng(base.lat, base.lon);

   if (
     polygon &&
     polygon.getBounds().contains(latlng) &&
     map.hasLayer(marker)
   ) {
     // highlight selected marker
     marker.setStyle?.({ color: "#ffff00", fillColor: "#ffff00" });

     count++; // ✅ only counting here
   } else {
     // restore original color
     const sym = symbolMap[key];
     marker.setStyle?.({ color: sym.color, fillColor: sym.color });
   }
 });
});

document.getElementById("selectionCount").textContent = count;
}


// ===== COMPLETE SELECTED STOPS =====


  


// ===== WHEN POLYGON IS DRAWN =====
map.on(L.Draw.Event.CREATED, e => {
  drawnLayer.clearLayers();
  drawnLayer.addLayer(e.layer);
  updateSelectionCount();
  updateUndoButtonState();   // 🔥 ADD THIS
});

// Default map
baseMaps.streets.addTo(map);

// Dropdown to switch map type
document.getElementById("baseMapSelect").addEventListener("change", e => {
  Object.values(baseMaps).forEach(l => map.removeLayer(l));
  map.removeLayer(satelliteLabelsLayer);

  const selected = e.target.value;
  baseMaps[selected].addTo(map);

  if (selected === "satellite" && map.getZoom() >= 15) {
    satelliteLabelsLayer.addTo(map);
  }
});


// ================= MAP SYMBOL SETTINGS =================
const colors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"];
const shapes = ["circle","square","triangle","diamond"];

const symbolMap = {};        // stores symbol for each route/day combo
const routeDayGroups = {};   // stores map markers grouped by route/day
// ===== DELIVERED STOPS LAYER =====


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


  function getMarkerPixelSize() {
  const z = map.getZoom();

  const steps = [
    [5, 0.03],     // almost invisible when fully zoomed out
    [7, 0.08],
    [9, 0.2],
    [11, 0.6],
    [13, 1.5],
    [15, 3.5],
    [Infinity, 6]
  ];

  return steps.find(([max]) => z <= max)[1];
}





// Create marker with correct shape
function createMarker(lat, lon, symbol) {
  const size = getMarkerPixelSize();

  // ===== CIRCLE =====
  if (symbol.shape === "circle") {
    const marker = L.circleMarker([lat, lon], {
      radius: size,
      color: symbol.color,
      fillColor: symbol.color,
      fillOpacity: 0.95,
      renderer: canvasRenderer
    });

    marker._base = { lat, lon, symbol };
    return marker;
  }

  function pixelOffset() {
    const zoom = map.getZoom();
    const scale = 40075016.686 / Math.pow(2, zoom + 8);
    const latOffset = size * scale / 111320;
    const lngOffset = latOffset / Math.cos(lat * Math.PI / 180);
    return [latOffset, lngOffset];
  }

  const [dLat, dLng] = pixelOffset();

  let shape;

  if (symbol.shape === "square") {
    shape = L.rectangle([[lat - dLat, lon - dLng], [lat + dLat, lon + dLng]], {
      color: symbol.color,
      fillColor: symbol.color,
      fillOpacity: 0.95,
      weight: 1,
      renderer: canvasRenderer
    });
  }

  if (symbol.shape === "triangle") {
    shape = L.polygon(
      [[lat + dLat, lon], [lat - dLat, lon - dLng], [lat - dLat, lon + dLng]],
      {
        color: symbol.color,
        fillColor: symbol.color,
        fillOpacity: 0.95,
        weight: 1,
        renderer: canvasRenderer
      }
    );
  }

  if (symbol.shape === "diamond") {
    shape = L.polygon(
      [[lat + dLat, lon], [lat, lon + dLng], [lat - dLat, lon], [lat, lon - dLng]],
      {
        color: symbol.color,
        fillColor: symbol.color,
        fillOpacity: 0.95,
        weight: 1,
        renderer: canvasRenderer
      }
    );
  }

  shape._base = { lat, lon, symbol };
  return shape;
}



// ================= FILTER CHECKBOX UI =================
function buildRouteCheckboxes(routes) {
  const c = document.getElementById("routeCheckboxes");
  c.innerHTML = "";

  routes.forEach(route => {
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = route;
    checkbox.checked = true;
    checkbox.addEventListener("change", applyFilters);

    const text = document.createTextNode(" " + route);

    label.appendChild(checkbox);
    label.appendChild(text);

    c.appendChild(label);
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



// ===== Route + Day ALL / NONE =====
document.getElementById("routeDayAll").onclick  = () => {
  document.querySelectorAll("#routeDayLayers input[type='checkbox']")
    .forEach(cb => {
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    });
};

document.getElementById("routeDayNone").onclick = () => {
  document.querySelectorAll("#routeDayLayers input[type='checkbox']")
    .forEach(cb => {
      cb.checked = false;
      cb.dispatchEvent(new Event("change"));
    });
};


// ================= APPLY MAP FILTERS =================
function applyFilters() {

  const routeCheckboxes = [...document.querySelectorAll("#routeCheckboxes input")];
  const dayCheckboxes   = [...document.querySelectorAll("#dayCheckboxes input")];

  let routes = routeCheckboxes.filter(i => i.checked).map(i => i.value);
  const days = dayCheckboxes.filter(i => i.checked).map(i => i.value);

  // 🔥 PREVENT route + delivered from both being active
  const activeRoutes = new Set(routes);

  activeRoutes.forEach(route => {

    if (route.endsWith("|Delivered")) {

      const baseRoute = route.replace("|Delivered", "");

      if (activeRoutes.has(baseRoute)) {
        const baseCheckbox = routeCheckboxes.find(cb => cb.value === baseRoute);
        if (baseCheckbox) baseCheckbox.checked = false;
        activeRoutes.delete(baseRoute);
      }

    } else {

      const deliveredRoute = route + "|Delivered";

      if (activeRoutes.has(deliveredRoute)) {
        const deliveredCheckbox = routeCheckboxes.find(cb => cb.value === deliveredRoute);
        if (deliveredCheckbox) deliveredCheckbox.checked = false;
        activeRoutes.delete(deliveredRoute);
      }

    }

  });

  routes = Array.from(activeRoutes);

  // 🔥 Now apply visibility
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
  // ===== BUILD ROUTE + DAY LAYER CHECKBOXES =====
// ===== BUILD ROUTE + DAY LAYER CHECKBOXES =====
function buildRouteDayLayerControls() {
  const routeDayContainer = document.getElementById("routeDayLayers");
  const deliveredContainer = document.getElementById("deliveredControls");

  if (!routeDayContainer || !deliveredContainer) return;

  routeDayContainer.innerHTML = "";
  deliveredContainer.innerHTML = "";

  Object.entries(routeDayGroups).forEach(([key, group]) => {
    const count = group.layers ? group.layers.length : 0;
    const [route, type] = key.split("|");
    const dayNameMap = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday"
};

    // === ROW WRAPPER ===
const wrapper = document.createElement("div");
wrapper.className = "layer-item";


  
    // === CHECKBOX ===
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.key = key;

    // Default state on load:
// Route + Day = checked
// Delivered = unchecked

if (layerVisibilityState.hasOwnProperty(key)) {
  checkbox.checked = layerVisibilityState[key];
} else {
  if (type === "Delivered") {
    checkbox.checked = false;
    layerVisibilityState[key] = false;
  } else {
    checkbox.checked = true;
    layerVisibilityState[key] = true;
  }
}

    // Apply visibility immediately
    routeDayGroups[key].layers.forEach(marker => {
      if (checkbox.checked) {
        map.addLayer(marker);
      } else {
        map.removeLayer(marker);
      }
    });

    // Toggle behavior
    checkbox.addEventListener("change", () => {

  layerVisibilityState[key] = checkbox.checked;

  const [route, type] = key.split("|");

  // 🚫 Prevent Route + Delivered both visible
  Object.keys(routeDayGroups).forEach(otherKey => {

    const [otherRoute, otherType] = otherKey.split("|");

    if (
      otherRoute === route &&
      otherKey !== key &&
      (
        (type === "Delivered" && otherType !== "Delivered") ||
        (type !== "Delivered" && otherType === "Delivered")
      )
    ) {
      // uncheck the conflicting layer
      layerVisibilityState[otherKey] = false;

      const otherCheckbox =
        document.querySelector(`input[data-key="${otherKey}"]`);

      if (otherCheckbox) otherCheckbox.checked = false;

      routeDayGroups[otherKey].layers.forEach(m =>
        map.removeLayer(m)
      );
    }
  });

  // Apply this checkbox visibility
  routeDayGroups[key].layers.forEach(marker => {
    if (checkbox.checked) {
      map.addLayer(marker);
    } else {
      map.removeLayer(marker);
    }
  });

});


    // === SYMBOL PREVIEW ===
    const symbol = getSymbol(key);

    const preview = document.createElement("span");
    preview.className = "layer-preview";
    preview.style.background = symbol.color;

    if (symbol.shape === "circle") preview.style.borderRadius = "50%";
    if (symbol.shape === "square") preview.style.borderRadius = "2px";

    if (symbol.shape === "triangle") {
      preview.style.background = "transparent";
      preview.style.width = "0";
      preview.style.height = "0";
      preview.style.borderLeft = "7px solid transparent";
      preview.style.borderRight = "7px solid transparent";
      preview.style.borderBottom = `14px solid ${symbol.color}`;
    }

    if (symbol.shape === "diamond") {
      preview.style.transform = "rotate(45deg)";
    }

    // === LABEL ===
    const labelText = document.createElement("span");
   if (type !== "Delivered") {
  const dayName = dayNameMap[type] || type;
 if (type !== "Delivered") {
  const dayName = dayNameMap[type] || type;
  labelText.textContent = `Route ${route} - ${dayName} (${count})`;
} else {
  labelText.textContent = `Route ${route} - Delivered (${count})`;
}

} else {
  labelText.textContent = `Route ${route} - Delivered (${count})`;
}



    // === BUILD ROW ===
    wrapper.appendChild(checkbox);
    wrapper.appendChild(preview);
    wrapper.appendChild(labelText);
    

    // === Decide which container ===
    if (type === "Delivered") {
      deliveredContainer.appendChild(wrapper);
    } else {
      routeDayContainer.appendChild(wrapper);
    }
  });
}


// ================= PROCESS ROUTE EXCEL =================
function processExcelBuffer(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(ws);

  // store globally for saving later
  window._currentRows = rows;
  window._currentWorkbook = wb;

  // Clear previous map data
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

    let key;

const status = String(row.del_status || "")
  .trim()
  .toLowerCase();

if (status === "delivered") {
  key = `${route}|Delivered`;
} else {
  key = `${route}|${day}`;
}


    const symbol = getSymbol(key);

    if (!routeDayGroups[key]) routeDayGroups[key] = { layers: [] };

  // Build full street address safely
const fullAddress = [
  row["CSADR#"] || "",
  row["CSSDIR"] || "",
  row["CSSTRT"] || "",
  row["CSSFUX"] || ""
].join(" ").replace(/\s+/g, " ").trim();

// Build popup content
const popupContent = `
  <div style="font-size:14px; line-height:1.4;">
    <div style="font-weight:bold; font-size:15px; margin-bottom:6px;">
      ${fullAddress || "Address not available"}
    </div>

    <div><strong>Container Size:</strong> ${row["SIZE"] || "-"}</div>
    <div><strong>Quantity:</strong> ${row["QTY"] || "-"}</div>
    <div><strong>Bin #:</strong> ${row["BINNO"] || "-"}</div>
  </div>
`;

const marker = createMarker(lat, lon, symbol)
  .bindPopup(popupContent)
  .addTo(map);
// ===== STREET LABEL (ZOOM-BASED) =====
const streetNumber = row["CSADR#"] ? String(row["CSADR#"]).trim() : "";
const streetName = row["CSSTRT"] ? String(row["CSSTRT"]).trim() : "";

const labelText = `${streetNumber} ${streetName}`.trim();

if (labelText) {
  marker.bindTooltip(labelText, {
    permanent: false,
    direction: "top",
    offset: [0, -8],
    className: "street-label"
  });

  marker._hasStreetLabel = true;
}


    // 🔥 CRITICAL: link marker to Excel row
    marker._rowRef = row;

  // ✅ Bright green delivered styling (SAFE + NORMALIZED)
if (status === "delivered") {
  marker.setStyle?.({
    color: "#00FF00",
    fillColor: "#00FF00",
    fillOpacity: 1,
    opacity: 1
  });
}

    
    routeDayGroups[key].layers.push(marker);
    routeSet.add(route);
    globalBounds.extend([lat, lon]);
  });

  buildRouteCheckboxes([...routeSet]);
  buildRouteDayLayerControls();
  applyFilters();

  if (globalBounds.isValid()) map.fitBounds(globalBounds);
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

  // 🔥 FORCE FRESH FILE (NO CACHE)
  const urlWithBypass = data.publicUrl + "?v=" + Date.now();

  const r = await fetch(urlWithBypass, {
    cache: "no-store"
  });

  // ⭐ STORE CURRENT CLOUD FILE PATH (REQUIRED FOR SAVE)
  window._currentFilePath = routeName;

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

  const entered = prompt("Enter password to delete this file:");

  if (entered !== DELETE_PASSWORD) {
    alert("❌ Incorrect password. File not deleted.");
    return;
  }

  const confirmed = confirm("Are you sure you want to permanently delete this file?");
  if (!confirmed) return;

  const toDelete = [routeName];
  if (summaryName) toDelete.push(summaryName);

  await sb.storage.from(BUCKET).remove(toDelete);

  alert("✅ File deleted successfully.");
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

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(file.name, file, { upsert: true });

  if (error) {
    console.error("UPLOAD ERROR:", error);
    alert("Upload failed: " + error.message);
    return;
  }

  // remember current cloud file
  window._currentFilePath = file.name;

  processExcelBuffer(await file.arrayBuffer());
  listFiles();
}


// ================= ROUTE SUMMARY DISPLAY =================
function showRouteSummary(rows, headers)
 {
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

// AUTO-OPEN + FORCE VISIBLE HEIGHT
const savedHeight = localStorage.getItem("summaryHeight");

// Always prepare a usable expanded height
const defaultHeight = window.innerWidth <= 900 ? 300 : 250;
panel.style.height = (savedHeight && savedHeight > 60 ? savedHeight : defaultHeight) + "px";

// Only auto-open on desktop
if (window.innerWidth > 900) {
  panel.classList.remove("collapsed");
  btn.textContent = "▼";
}


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

// Read entire sheet as grid
const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });

// ===== FIND FIRST NON-EMPTY ROW =====
let startRow = raw.findIndex(r =>
  r && r.some(cell => String(cell || "").trim() !== "")
);

if (startRow === -1) {
  showRouteSummary([], []);
  return;
}

// ===== DETECT MULTI-ROW HEADERS (supports 1–3+) =====
let headerRows = [raw[startRow]];
let nextRow = raw[startRow + 1];
let thirdRow = raw[startRow + 2];

function looksLikeHeader(row) {
  if (!row) return false;

  const filled = row.filter(c => String(c || "").trim() !== "").length;
  const numeric = row.filter(c => !isNaN(parseFloat(c))).length;

  return filled > 0 && numeric < filled / 2;
}

if (looksLikeHeader(nextRow)) headerRows.push(nextRow);
if (looksLikeHeader(thirdRow)) headerRows.push(thirdRow);

// ===== BUILD SAFE COLUMN NAMES =====
const columnCount = Math.max(...headerRows.map(r => r.length));

const headers = Array.from({ length: columnCount }, (_, col) => {
  const parts = headerRows
    .map(r => String(r[col] || "").trim())
    .filter(Boolean);

  return parts.join(" ") || `Column ${col + 1}`;
});

// ===== DATA STARTS AFTER HEADER =====
const dataStartIndex = startRow + headerRows.length;

// ===== BUILD ROW OBJECTS =====
const rows = raw.slice(dataStartIndex).map(r => {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = r?.[i] ?? "";
  });
  return obj;
});




showRouteSummary(rows, headers);


// 🔽 FORCE the panel open when a summary exists
const panel = document.getElementById("bottomSummary");
const btn = document.getElementById("summaryToggleBtn");

const isMobile = window.innerWidth <= 900;

if (panel && btn && !isMobile) {
  panel.classList.remove("collapsed");
  btn.textContent = "▼";
}



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
// ===== PLACE LOCATE BUTTON BASED ON SCREEN SIZE =====
function placeLocateButton() {
  const locateBtn = document.getElementById("locateMeBtn");
  const completeBtn = document.getElementById("completeStopsBtn");
  const headerContainer = document.querySelector(".mobile-header-buttons");
  const desktopContainer = document.getElementById("desktopLocateContainer");
  const undoBtn = document.getElementById("undoDeliveredBtn");
  const streetToggle = document.getElementById("streetLabelToggle");

  if (!locateBtn || !completeBtn || !headerContainer || !desktopContainer) return;

  if (window.innerWidth <= 900) {
    // 📱 MOBILE
    headerContainer.appendChild(locateBtn);
    headerContainer.appendChild(completeBtn);
    if (undoBtn) headerContainer.appendChild(undoBtn);

    if (streetToggle) {
      headerContainer.appendChild(streetToggle.parentElement);
    }

    completeBtn.textContent = "✔";

  } else {
    // 🖥 DESKTOP
    desktopContainer.appendChild(locateBtn);
    desktopContainer.appendChild(completeBtn);
    if (undoBtn) desktopContainer.appendChild(undoBtn);

    if (streetToggle) {
      desktopContainer.appendChild(streetToggle.parentElement);
    }

    completeBtn.textContent = "Complete Stops";
  }
}

//undo button state
function updateUndoButtonState() {
  const undoBtn = document.getElementById("undoDeliveredBtn");
  if (!undoBtn) return;

  const polygon = drawnLayer.getLayers()[0];
  if (!polygon) {
    undoBtn.classList.remove("pulse");
    return;
  }

  let hasDeliveredInSelection = false;

  Object.entries(routeDayGroups).forEach(([key, group]) => {

    if (!key.endsWith("|Delivered")) return;

    group.layers.forEach(marker => {

      if (!map.hasLayer(marker)) return;

      const pos = marker.getLatLng();

      if (
        polygon.getBounds().contains(pos) &&
        marker._rowRef &&
        String(marker._rowRef.del_status || "").trim().toLowerCase() === "delivered"
      ) {
        hasDeliveredInSelection = true;
      }

    });
  });

  if (hasDeliveredInSelection) {
    undoBtn.classList.add("pulse");
  } else {
    undoBtn.classList.remove("pulse");
  }
}









function initApp() { //begining of initApp=================================================================

// ===== RIGHT SIDEBAR TOGGLE =====

// ===== RIGHT SIDEBAR TOGGLE =====
const selectionBox = document.getElementById("selectionBox");
const toggleSelectionBtn = document.getElementById("toggleSelectionBtn");
const clearBtn = document.getElementById("clearSelectionBtn");

// ===== COMPLETE STOPS BUTTON =====
const completeBtnDesktop = document.getElementById("completeStopsBtn");
const completeBtnMobile  = document.getElementById("completeStopsBtnMobile");


  
// Toggle sidebar open/closed
if (selectionBox && toggleSelectionBtn) {
  toggleSelectionBtn.onclick = () => {
    const collapsed = selectionBox.classList.toggle("collapsed");
    toggleSelectionBtn.textContent = collapsed ? "❮" : "❯";
  };
}

// Clear selection button (ALWAYS ACTIVE)
if (clearBtn) {
  clearBtn.onclick = () => {
    // Remove polygon
    drawnLayer.clearLayers();

    


    // Restore original marker colors
    Object.entries(routeDayGroups).forEach(([key, group]) => {
      const sym = symbolMap[key];
      group.layers.forEach(marker => {
        marker.setStyle?.({ color: sym.color, fillColor: sym.color });
      });
    });

    // 🔥 Force counter refresh everywhere (desktop + mobile)
    updateSelectionCount();
    updateUndoButtonState();
  };
}







  
// ===== FILE UPLOAD (DRAG + CLICK) =====
const dropZone = document.getElementById("dropZone");

// create hidden file input dynamically (so no HTML change needed)
let fileInput = document.getElementById("fileInput");
if (!fileInput) {
  fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".xlsx,.xls,.csv";
  fileInput.id = "fileInput";
  fileInput.hidden = true;
  document.body.appendChild(fileInput);
}

// CLICK → open picker
dropZone.addEventListener("click", () => fileInput.click());

// FILE SELECTED
fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) uploadFile(file);
});

// PREVENT browser opening file on drop
["dragenter", "dragover", "dragleave", "drop"].forEach(evt => {
  dropZone.addEventListener(evt, e => e.preventDefault());
});

// DROP → upload
dropZone.addEventListener("drop", e => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});


// ===== INITIAL MAP LAYER + USER LOCATION =====
baseMaps.streets.addTo(map);



  
  // ===== BASE MAP DROPDOWN =====
  const baseSelect = document.getElementById("baseMapSelect");
if (baseSelect) {
  baseSelect.addEventListener("change", e => {
    Object.values(baseMaps).forEach(l => map.removeLayer(l));
    map.removeLayer(satelliteLabelsLayer);

    const selected = e.target.value;
    baseMaps[selected].addTo(map);

    if (selected === "satellite" && map.getZoom() >= 15) {
      satelliteLabelsLayer.addTo(map);
    }
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

const overlay = document.querySelector(".mobile-overlay");

if (mobileMenuBtn && sidebar && overlay) {

  mobileMenuBtn.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");

    mobileMenuBtn.textContent = open ? "✕" : "☰";
    overlay.classList.toggle("show", open);

    setTimeout(() => map.invalidateSize(), 200);
  });

  overlay.addEventListener("click", () => {
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
    mobileMenuBtn.textContent = "☰";
  });
}
// ===== MOBILE SELECTION TOGGLE =====
const mobileSelBtn = document.getElementById("mobileSelectionBtn");


if (mobileSelBtn && selectionBox) {

  mobileSelBtn.addEventListener("click", () => {
    selectionBox.classList.toggle("show");
  });

  // keep count synced
  const originalUpdate = updateSelectionCount;
  updateSelectionCount = function () {
    originalUpdate();
    mobileSelBtn.textContent =
      "Selected: " + document.getElementById("selectionCount").textContent;
  };
}


  // ===== RESIZABLE BOTTOM SUMMARY PANEL =====
  const panel = document.getElementById("bottomSummary");
  const header = document.querySelector(".bottom-summary-header");
  const toggleBtn = document.getElementById("summaryToggleBtn");

  if (panel && header) {
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    // Restore saved height
    const savedHeight = localStorage.getItem("summaryHeight");
    if (savedHeight) panel.style.height = savedHeight + "px";

    // ===== FORCE MOBILE TO START COLLAPSED =====
if (window.innerWidth <= 900) {
  panel.classList.add("collapsed");
  panel.style.height = "40px";
}

    // Drag resize
    header.addEventListener("mousedown", e => {
      isDragging = true;
      startY = e.clientY;
      startHeight = panel.offsetHeight;
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", e => {
      if (!isDragging) return;

      const delta = startY - e.clientY;
      let newHeight = startHeight + delta;

      const minHeight = 40;
      const maxHeight = window.innerHeight - 100;

      newHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
      panel.style.height = newHeight + "px";
    });

    document.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;
  document.body.style.userSelect = "";
  localStorage.setItem("summaryHeight", panel.offsetHeight);

  // Hide resize hint after first drag
  const hint = document.querySelector(".resize-hint");
  if (hint) hint.style.display = "none";
});


    // Collapse toggle
if (toggleBtn) {
  toggleBtn.onclick = () => {
    const isCollapsed = panel.classList.toggle("collapsed");

   if (isCollapsed) {
  localStorage.setItem("summaryHeight", panel.offsetHeight);
  panel.style.height = "40px";
  toggleBtn.textContent = "▲";
} else {
  let restored = localStorage.getItem("summaryHeight");

  if (!restored || restored <= 60) {
    restored = window.innerWidth <= 900 ? 300 : 250;
  }

  panel.style.height = restored + "px";
  toggleBtn.textContent = "▼";
}

  };
}

  }

  // ===== POP-OUT SUMMARY WINDOW =====
  const popoutBtn = document.getElementById("popoutSummaryBtn");

  if (popoutBtn) {
    popoutBtn.onclick = () => {
      const tableHTML = document.getElementById("routeSummaryTable")?.innerHTML;

      if (!tableHTML || tableHTML.includes("No summary")) {
        alert("No route summary loaded.");
        return;
      }

      const win = window.open("", "_blank", "width=900,height=600,resizable=yes,scrollbars=yes");

      win.document.write(`
        <html>
          <head>
            <title>Route Summary</title>
            <style>
              body { font-family: Roboto, sans-serif; margin: 10px; }
              table { border-collapse: collapse; width: 100%; }
              th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
              th { background: #f4f4f4; position: sticky; top: 0; }
            </style>
          </head>
          <body>
            <h2>Route Summary</h2>
            ${tableHTML}
          </body>
        </html>
      `);

      win.document.close();
    };
  }
//======
// ===== RESET MAP BUTTON (TRUE HARD RESET FOR THIS APP) =====
const resetBtn = document.getElementById("resetMapBtn");

if (resetBtn) {
  resetBtn.addEventListener("click", () => {

    // 1. Reset map view
    map.setView([39.5, -98.35], 4);

    // 2. Clear drawn polygon
    drawnLayer.clearLayers();

    // 3. Remove ALL markers from map
    Object.values(routeDayGroups).forEach(group => {
      group.layers.forEach(marker => map.removeLayer(marker));
    });

    // 4. Clear stored marker groups & symbols
    Object.keys(routeDayGroups).forEach(k => delete routeDayGroups[k]);
    Object.keys(symbolMap).forEach(k => delete symbolMap[k]);

    // 5. Reset counters & stats
    document.getElementById("selectionCount").textContent = "0";
    document.getElementById("statsList").innerHTML = "";

    // 6. Clear route/day checkbox UI
    document.getElementById("routeCheckboxes").innerHTML = "";
    buildDayCheckboxes();

    // 7. Reset bounds tracker
    globalBounds = L.latLngBounds();

    // 8. Clear bottom summary
    const summary = document.getElementById("routeSummaryTable");
    if (summary) summary.innerHTML = "No summary loaded";

    // 9. Collapse summary panel
    const panel = document.getElementById("bottomSummary");
    const btn = document.getElementById("summaryToggleBtn");
    if (panel && btn) {
      panel.classList.add("collapsed");
      panel.style.height = "40px";
      btn.textContent = "▲";
    }
  });
}


// ===== LIVE GPS BUTTON =====
const locateBtn = document.getElementById("locateMeBtn");

if (locateBtn) {
  let tracking = false;

  locateBtn.addEventListener("click", () => {
    if (!tracking) {
      startLiveTracking();
      locateBtn.textContent = "■";
      locateBtn.classList.add("tracking");   // 🔴 turns button red
      tracking = true;
    } else {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      if (headingMarker) {
  map.removeLayer(headingMarker);
  headingMarker = null;
}

window.removeEventListener("deviceorientation", updateHeading);


      locateBtn.textContent = "📍";
      locateBtn.classList.remove("tracking"); // 🔵 back to blue
      tracking = false;
    }
  });
}


  

// ===== DOWNLOAD FULL EXCEL (WITH CONFIRM MODAL) =====
const downloadBtn = document.getElementById("downloadFullExcelBtn");
const modal = document.getElementById("downloadConfirmModal");
const confirmBtn = document.getElementById("confirmDownload");
const cancelBtn = document.getElementById("cancelDownload");

if (downloadBtn && modal && confirmBtn && cancelBtn) {

  // Open confirmation modal
  downloadBtn.addEventListener("click", () => {

    if (!window._currentWorkbook) {
      alert("No Excel file loaded.");
      return;
    }

    modal.style.display = "flex";
  });

  // Cancel download
  cancelBtn.addEventListener("click", () => {
    modal.style.display = "none";
  });

  // Confirm download
  confirmBtn.addEventListener("click", () => {

    modal.style.display = "none";

    if (!window._currentWorkbook) {
      alert("No Excel file loaded.");
      return;
    }

    const now = new Date();

    const timestamp =
      now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0") + "_" +
      String(now.getHours()).padStart(2, "0") + "-" +
      String(now.getMinutes()).padStart(2, "0") + "-" +
      String(now.getSeconds()).padStart(2, "0");

    let baseName = window._currentFilePath || "Export";
    baseName = baseName.replace(/\.[^/.]+$/, "");

    const newFileName = `${baseName}_Downloaded_${timestamp}.xlsx`;

    XLSX.writeFile(window._currentWorkbook, newFileName);
  });
}




// ===== AUTO-RESIZE MARKERS ON ZOOM =====
map.on("zoomend", () => {
  window._labelCount = 0;

  const newSize = getMarkerPixelSize();
  const currentZoom = map.getZoom();
  const maxZoom = map.getMaxZoom();

// ===== AUTO TOGGLE SATELLITE STREET NAMES =====
const currentBase = document.getElementById("baseMapSelect")?.value;

if (currentBase === "satellite") {
  if (map.getZoom() >= 15) {
    map.addLayer(satelliteLabelsLayer);
  } else {
    map.removeLayer(satelliteLabelsLayer);
  }
} else {
  map.removeLayer(satelliteLabelsLayer);
}


  Object.values(routeDayGroups).forEach(group => {
    group.layers.forEach(layer => {
      const base = layer._base;
      if (!base) return;

      // ---- Resize markers (your existing logic) ----
      if (layer.setRadius) {
        layer.setRadius(newSize);
      } else {
        const { lat, lon, symbol } = base;

        const scale = 40075016.686 / Math.pow(2, currentZoom + 8);
        const dLat = newSize * scale / 111320;
        const dLng = dLat / Math.cos(lat * Math.PI / 180);

        if (symbol.shape === "square") {
          layer.setBounds([[lat - dLat, lon - dLng], [lat + dLat, lon + dLng]]);
        }

        if (symbol.shape === "triangle") {
          layer.setLatLngs([
            [lat + dLat, lon],
            [lat - dLat, lon - dLng],
            [lat - dLat, lon + dLng]
          ]);
        }

        if (symbol.shape === "diamond") {
          layer.setLatLngs([
            [lat + dLat, lon],
            [lat, lon + dLng],
            [lat - dLat, lon],
            [lat, lon - dLng]
          ]);
        }
      }

     // ---- STREET LABEL LOGIC (MOBILE SAFE) ----
if (layer._hasStreetLabel) {

  const bounds = map.getBounds();
  const isVisible = bounds.contains(layer.getLatLng());

  // HARD LIMIT to prevent mobile overload
  const MAX_LABELS = 150;

  if (!window._labelCount) window._labelCount = 0;

  if (
   currentZoom >= maxZoom - 2 &&
    window.streetLabelsEnabled &&
    map.hasLayer(layer) &&
    isVisible &&
    window._labelCount < MAX_LABELS
  ) {
    layer.openTooltip();
    window._labelCount++;
  } else {
    layer.closeTooltip();
  }
}

    });
  });
});

  
// Position Locate button correctly for desktop/mobile
placeLocateButton();
window.addEventListener("resize", placeLocateButton);

  // Position Locate button correctly for desktop/mobile
placeLocateButton();
window.addEventListener("resize", placeLocateButton);


// ===== STREET LABEL TOGGLE =====
document.getElementById("streetLabelToggle").addEventListener("change", (e) => {
  window.streetLabelsEnabled = e.target.checked;
  map.fire("zoomend"); // refresh labels immediately
});
////////////////central save function
async function saveWorkbookToCloud() {

  const newSheet = XLSX.utils.json_to_sheet(window._currentRows);
  window._currentWorkbook.Sheets[
    window._currentWorkbook.SheetNames[0]
  ] = newSheet;

  const bookType = window._currentFilePath.toLowerCase().endsWith(".xlsm")
    ? "xlsm"
    : "xlsx";

  const wbArray = XLSX.write(window._currentWorkbook, {
    bookType,
    type: "array"
  });

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(window._currentFilePath, wbArray, {
      upsert: true,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });

  if (error) {
    console.error("Cloud Save Error:", error);
    return false;
  }

  return true;
}


// ================= COMPLETE STOPS + SAVE TO CLOUD =================
async function completeStops() {
  if (!window._currentRows || !window._currentWorkbook || !window._currentFilePath) {
    alert("No Excel file loaded.");
    return;
  }

  const polygon = drawnLayer.getLayers()[0];
  if (!polygon) {
    alert("Draw a selection first.");
    return;
  }

  let completedCount = 0;
 


  // find markers inside polygon
  // 🔥 ONLY process NON-Delivered layers
Object.entries(routeDayGroups).forEach(([key, group]) => {

  if (key.endsWith("|Delivered")) return;
  if (!layerVisibilityState[key]) return; // 🔥 ONLY active layer

  group.layers.slice().forEach(marker => {

    const pos = marker.getLatLng();

    if (polygon.getBounds().contains(pos) && marker._rowRef) {

      const row = marker._rowRef;

      row.del_status = "Delivered";

      routeDayGroups[key].layers =
        routeDayGroups[key].layers.filter(l => l !== marker);

      const deliveredKey = `${row.NEWROUTE}|Delivered`;

      if (!routeDayGroups[deliveredKey]) {
        routeDayGroups[deliveredKey] = { layers: [] };
      }

      marker.setStyle?.({
        color: "#00FF00",
        fillColor: "#00FF00",
        fillOpacity: 1,
        opacity: 1
      });

      routeDayGroups[deliveredKey].layers.push(marker);

      completedCount++;
    }

  });

});


  if (completedCount === 0) {
    alert("No stops inside selection.");
    return;
  }

  // rewrite worksheet from updated rows
  const saved = await saveWorkbookToCloud();

if (!saved) {
  alert("❌ Cloud save failed. Excel file was NOT updated.");
  return;
}

// 🔥 remove selection polygon after completion
drawnLayer.clearLayers();
  // Save current checkbox states
document.querySelectorAll("#routeDayLayers input[type='checkbox']")
  .forEach(cb => {
    const key = cb.dataset.key;
    if (key) layerVisibilityState[key] = cb.checked;
  });

document.querySelectorAll("#deliveredControls input[type='checkbox']")
  .forEach(cb => {
    const key = cb.dataset.key;
    if (key) layerVisibilityState[key] = cb.checked;
  });

buildRouteDayLayerControls(); // refresh UI
updateUndoButtonState();

// 🔥 CLEAR selection + counter AFTER UI rebuild
// 🔥 CLEAR polygon
if (drawnLayer) {
  drawnLayer.clearLayers();
}

// 🔥 Recalculate + restore marker styling properly
updateSelectionCount();
updateUndoButtonState();

alert(`${completedCount} stop(s) marked Delivered and saved.`);


}
////////undo delivered stops
async function undoDelivered() {

  const confirmed = confirm("Are you sure you want to undo Delivered stops inside the selected area?");
  if (!confirmed) return;

  if (!window._currentRows || !window._currentWorkbook || !window._currentFilePath) {
    alert("No Excel file loaded.");
    return;
  }


  const polygon = drawnLayer.getLayers()[0];
  if (!polygon) {
    alert("Draw a selection first.");
    return;
  }

  let undoCount = 0;

  // 🔥 ONLY loop Delivered groups
  Object.entries(routeDayGroups).forEach(([key, group]) => {

    if (!key.endsWith("|Delivered")) return;  // HARD FILTER

    group.layers.slice().forEach(marker => {

      const pos = marker.getLatLng();

      // must be inside selection AND actually marked Delivered
      if (
        polygon.getBounds().contains(pos) &&
        marker._rowRef &&
        String(marker._rowRef.del_status || "").trim().toLowerCase() === "delivered"
      ) {

        const row = marker._rowRef;

        // remove Delivered from Excel data
        row.del_status = "";

        // remove marker from Delivered layer
        routeDayGroups[key].layers =
          routeDayGroups[key].layers.filter(l => l !== marker);

        // restore original route/day layer
        const originalKey = `${row.NEWROUTE}|${row.NEWDAY}`;

        if (!routeDayGroups[originalKey]) {
          routeDayGroups[originalKey] = { layers: [] };
        }

        const symbol = getSymbol(originalKey);

        marker.setStyle?.({
          color: symbol.color,
          fillColor: symbol.color,
          fillOpacity: 0.95,
          opacity: 1
        });

        routeDayGroups[originalKey].layers.push(marker);

        undoCount++;
      }
    });
  });

  if (undoCount === 0) {
    alert("No Delivered stops inside selection.");
    return;
  }

  // Rewrite Excel sheet
 const saved = await saveWorkbookToCloud();

if (!saved) {
  alert("❌ Cloud save failed. Excel file was NOT updated.");
  return;
}


// 🔥 CLEAR polygon
if (drawnLayer) {
  drawnLayer.clearLayers();
}

// 🔥 Recalculate selection state + restore styling
updateSelectionCount();
updateUndoButtonState();

buildRouteDayLayerControls();

alert(`${undoCount} stop(s) restored.`);

}
//////
  
// ===== DAYS COLLAPSIBLE =====
const daysToggle = document.getElementById("daysToggle");
const daysContent = document.getElementById("daysContent");

if (daysToggle && daysContent) {

  // Closed by default
  daysContent.classList.add("collapsed");

  daysToggle.addEventListener("click", (e) => {

    // Prevent clicking All/None from toggling collapse
    if (e.target.id === "daysAll" || e.target.id === "daysNone") return;

    const isCollapsed = daysContent.classList.toggle("collapsed");

    daysToggle.classList.toggle("open", !isCollapsed);
  });
}
//////////
  // ===== ROUTES COLLAPSIBLE =====
const routesToggle = document.getElementById("routesToggle");
const routesContent = document.getElementById("routesContent");

if (routesToggle && routesContent) {

  // Closed by default
  routesContent.classList.add("collapsed");

  routesToggle.addEventListener("click", (e) => {

    // Prevent clicking All/None from toggling collapse
    if (e.target.id === "routesAll" || e.target.id === "routesNone") return;

    const isCollapsed = routesContent.classList.toggle("collapsed");

    routesToggle.classList.toggle("open", !isCollapsed);
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


// ================= COMPLETE BUTTON EVENTS =================
document.getElementById("completeStopsBtn")
  ?.addEventListener("click", completeStops);

document.getElementById("completeStopsBtnMobile")
  ?.addEventListener("click", completeStops);
//undo delivered stops button event
  document.getElementById("undoDeliveredBtn")
  ?.addEventListener("click", undoDelivered);



  
  listFiles();
}
