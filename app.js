window.addEventListener("error", e => {
  console.error("JS ERROR:", e.message, "at line", e.lineno);
});

let layerVisibilityState = {};
let deliverySaveInProgress = false;
let selectedPendingStopCount = 0;

function updateDeliveryButtons() {
  const count = selectedPendingStopCount;
  const label = deliverySaveInProgress
    ? "Saving…"
    : count
      ? `Mark ${count} ${count === 1 ? "Stop" : "Stops"} Delivered`
      : "Mark Stops Delivered";

  ["completeStopsBtn", "completeStopsBtnMobile"].forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    button.textContent = label;
    button.disabled = deliverySaveInProgress || count === 0;
    button.setAttribute("aria-busy", String(deliverySaveInProgress));
    button.title = count ? label : "Select undelivered stops on the map first";
  });
  const undoButton = document.getElementById("undoDeliveredBtn");
  if (undoButton) undoButton.disabled = deliverySaveInProgress;
}

function updatePendingDeliveryCount(markers) {
  selectedPendingStopCount = [...markers].filter(marker =>
    marker._rowRef &&
    String(marker._rowRef.del_status || "").trim().toLowerCase() !== "delivered"
  ).length;
  updateDeliveryButtons();
}

function setDeliverySaveStatus(state, message) {
  deliverySaveInProgress = state === "saving";
  const status = document.getElementById("deliverySaveStatus");
  status.dataset.state = state;
  status.textContent = message;
  updateDeliveryButtons();
}

// ================= SUPABASE CONFIG =================
// Connection info for cloud file storage
const SUPABASE_URL = "https://lffazhbwvorwxineklsy.supabase.co";
const SUPABASE_KEY = "sb_publishable_Lfh2zlIiTSMB0U-Fe5o6Jg_mJ1qkznh";
const BUCKET = "excel-files";
// ===== CURRENT EXCEL STATE =====
window._currentRows = null;
window._currentWorkbook = null;
window._currentFilePath = null;
window._summaryRows = [];
window._summaryHeaders = [];

window.streetLabelsEnabled = false;

// Header tools menu links.
// Replace "#" with your real URLs and add more entries as needed.
const HEADER_TOOL_LINKS = [
  { label: "Sales-Polygon-Viewer", href: "#" },
  { label: "Cart Delivery App", href: "#" },
  { label: "Solution Reviewer", href: "#" }
];

function setupHeaderToolsMenu() {
  const setupToolsMenuInstance = (btnId, dropdownId, listId) => {
    const menuBtn = document.getElementById(btnId);
    const menuDropdown = document.getElementById(dropdownId);
    const menuList = document.getElementById(listId);

    if (!menuBtn || !menuDropdown || !menuList) return;

    menuList.innerHTML = "";

    HEADER_TOOL_LINKS.forEach(tool => {
      const link = document.createElement("a");
      link.className = "tools-menu-item";
      link.textContent = tool.label;
      link.href = tool.href || "#";

      if (!tool.href || tool.href === "#") {
        link.addEventListener("click", e => e.preventDefault());
      }

      menuList.appendChild(link);
    });

    const closeMenu = () => {
      menuDropdown.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    };

    menuBtn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = menuDropdown.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    menuDropdown.addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeMenu();
    });
  };

  setupToolsMenuInstance("toolsMenuBtn", "toolsMenuDropdown", "toolsMenuList");
  setupToolsMenuInstance("toolsMenuBtnMobile", "toolsMenuDropdownMobile", "toolsMenuListMobile");
}

//======
// 🔐 Delete protection password I know this is not secure, I just wanted to make it harder for ppl to accidentally delete files. You can change or remove this as needed.
const DELETE_PASSWORD = "Austin1";  // ← change to whatever you want


document.addEventListener("DOMContentLoaded", () => {
  initApp();
  document.addEventListener("DOMContentLoaded", initApp);
// ================= SUN MODE TOGGLE =================

const sunToggle = document.getElementById("sunModeToggle");
const sunToggleText = document.getElementById("sunToggleText");

function updateSunToggleText() {
  if (!sunToggle || !sunToggleText) return;
  sunToggleText.textContent = sunToggle.checked ? "Light Mode" : "Dark Mode";
}

// Load saved preference
if (localStorage.getItem("sunMode") === "on") {
  document.body.classList.add("sun-mode");
  if (sunToggle) sunToggle.checked = true;
}

updateSunToggleText();

if (sunToggle) {
  sunToggle.addEventListener("change", () => {
    if (sunToggle.checked) {
      document.body.classList.add("sun-mode");
      localStorage.setItem("sunMode", "on");
    } else {
      document.body.classList.remove("sun-mode");
      localStorage.setItem("sunMode", "off");
    }
    updateSunToggleText();
  });
}

setupHeaderToolsMenu();

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

  hardRefreshBtn.addEventListener("click", async () => {

    // Mobile double-tap protection
    if (window.innerWidth <= 900) {
      if (!refreshArmed) {
        refreshArmed = true;
        hardRefreshBtn.textContent = "Tap again to refresh app";

        setTimeout(() => {
          refreshArmed = false;
          hardRefreshBtn.textContent = "Refresh App";
        }, 2000);

        return;
      }
    }

    // Desktop confirmation
    if (window.innerWidth > 900) {
      const confirmed = confirm(
        "Refresh App will clear this app's local cached files and reload the page with fresh data. Continue?"
      );
      if (!confirmed) return;
    }

    // Clear cache storage if supported
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }

    // Unregister service workers so they cannot serve stale assets
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }

    // True hard reload (cache-busting URL)
    const url = new URL(window.location.href);
    url.searchParams.set("_cb", String(Date.now()));
    window.location.replace(url.toString());
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

// Prevent recursive growth like "..._Downloaded_<ts>_Downloaded_<ts>".
function getDownloadBaseName(filePath) {
  const rawName = (filePath || "Export").replace(/\.[^/.]+$/, "");
  return rawName.replace(
    /(?:_Downloaded_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})+$/i,
    ""
  );
}

function setCurrentFileDisplay(filePath) {
  const label = document.getElementById("currentFileDisplay");
  const name = document.getElementById("currentFileName");
  const displayName = filePath || "None";
  if (!label) return;

  if (name) {
    name.textContent = displayName;
    return;
  }

  label.textContent = `Current file: ${displayName}`;
}

setCurrentFileDisplay(window._currentFilePath);


// ================= MAP SETUP =================
// Create Leaflet map
const map = L.map("map").setView([0, 0], 2);
// Shared Canvas renderer for high-performance drawing
const canvasRenderer = L.canvas({ padding: 0.5 });


// ===== BASE MAP LAYERS =====
const baseMaps = {
  streets: L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      maxNativeZoom: 19
    }
  ),

  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      maxNativeZoom: 19
    }
  )
};
// ===== SATELLITE STREET NAME OVERLAY (LIGHTWEIGHT) =====
const satelliteLabelsLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    maxNativeZoom: 19,
    opacity: 1
  }
);

// ================= POLYGON SELECT =================


// when polygon created
// ================= POLYGON SELECT =================
let drawnLayer = new L.FeatureGroup();
map.addLayer(drawnLayer);
const individuallySelectedMarkers = new Set();
const individuallyDeselectedMarkers = new Set();
const highlightedMarkers = new Set();
let mobileStopSelectionMode = false;

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
function pointIsInsideRing(point, ring) {
  let inside = false;
  const pointOnSegment = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    const nearestX = a.x + fraction * dx;
    const nearestY = a.y + fraction * dy;
    return Math.hypot(point.x - nearestX, point.y - nearestY) <= 2;
  };

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(a, b)) return true;

    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }

  return inside;
}

function createSelectionTester() {
  const selection = drawnLayer.getLayers()[0];
  if (!selection) return () => false;

  const rings = [];
  const collectRings = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 3 && value[0] && Number.isFinite(value[0].lat) && Number.isFinite(value[0].lng)) {
      rings.push(value);
      return;
    }
    value.forEach(collectRings);
  };
  collectRings(selection.getLatLngs());

  if (!rings.length) return () => false;
  const projectedRings = rings.map(ring => ring.map(latlng => map.latLngToLayerPoint(latlng)));
  const outerRing = projectedRings[0];
  const extent = outerRing.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxY: Math.max(bounds.maxY, point.y)
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity
  });
  return latlng => {
    const point = map.latLngToLayerPoint(latlng);
    if (
      point.x < extent.minX - 2 ||
      point.x > extent.maxX + 2 ||
      point.y < extent.minY - 2 ||
      point.y > extent.maxY + 2
    ) {
      return false;
    }
    return pointIsInsideRing(point, projectedRings[0]) &&
      !projectedRings.slice(1).some(ring => pointIsInsideRing(point, ring));
  };
}

function isStopSelected(marker, selectionTester = createSelectionTester()) {
  if (!map.hasLayer(marker)) return false;
  if (individuallySelectedMarkers.has(marker)) return true;
  if (individuallyDeselectedMarkers.has(marker)) return false;
  const base = marker._base;
  const latlng = base && Number.isFinite(base.lat) && Number.isFinite(base.lon)
    ? L.latLng(base.lat, base.lon)
    : getLayerLatLng(marker);
  return Boolean(latlng && selectionTester(latlng));
}

function toggleIndividualStopSelection(marker) {
  const wasSelected = isStopSelected(marker);
  const selectionTester = createSelectionTester();
  const base = marker._base;
  const latlng = base && Number.isFinite(base.lat) && Number.isFinite(base.lon)
    ? L.latLng(base.lat, base.lon)
    : getLayerLatLng(marker);
  if (wasSelected) {
    individuallySelectedMarkers.delete(marker);
    if (drawnLayer.getLayers()[0] && latlng && selectionTester(latlng)) {
      individuallyDeselectedMarkers.add(marker);
    } else {
      individuallyDeselectedMarkers.delete(marker);
    }
  } else {
    individuallyDeselectedMarkers.delete(marker);
    individuallySelectedMarkers.add(marker);
  }
}

function getNearbyVisibleStops(latlng) {
  const tapPoint = map.latLngToContainerPoint(latlng);
  const nearby = [];

  Object.entries(routeDayGroups).forEach(([key, group]) => {
    group.layers.forEach(marker => {
      if (!map.hasLayer(marker)) return;
      const base = marker._base;
      const markerLatLng = base && Number.isFinite(base.lat) && Number.isFinite(base.lon)
        ? L.latLng(base.lat, base.lon)
        : getLayerLatLng(marker);
      if (!markerLatLng) return;

      const point = map.latLngToContainerPoint(markerLatLng);
      const distance = tapPoint.distanceTo(point);
      const hitRadius = Math.max(32, (marker.getRadius?.() || 0) + 20);
      if (distance <= hitRadius) nearby.push({ marker, key, distance });
    });
  });

  return nearby.sort((a, b) => a.distance - b.distance);
}

function formatStopAddress(row) {
  return [
    row["CSADR#"] || "",
    row["CSSDIR"] || "",
    row["CSSTRT"] || "",
    row["CSSFUX"] || ""
  ].join(" ").replace(/\s+/g, " ").trim() || "Address not available";
}

function showNearbyStopPicker(stops) {
  const picker = document.getElementById("mobileStopPicker");
  const list = document.getElementById("mobileStopPickerList");
  const message = document.getElementById("mobileStopPickerMessage");
  list.replaceChildren();
  message.textContent = `${stops.length} nearby stops. Choose the exact address:`;

  stops.forEach(({ marker, key, distance }) => {
    const row = marker._rowRef || {};
    const button = document.createElement("button");
    button.className = "mobile-stop-choice";
    button.type = "button";

    const address = document.createElement("span");
    address.className = "mobile-stop-choice-address";
    address.textContent = formatStopAddress(row);

    const detail = document.createElement("span");
    detail.className = "mobile-stop-choice-detail";
    const status = String(row.del_status || "").trim().toLowerCase() === "delivered"
      ? "Delivered"
      : (dayName(Number(row.NEWDAY)) || `Day ${row.NEWDAY || key.split("|")[1]}`);
    const bin = row.BINNO ? ` · Bin ${row.BINNO}` : "";
    detail.textContent = `Route ${row.NEWROUTE || key.split("|")[0]} · ${status}${bin} · ${Math.round(distance)} px away`;

    const selectionState = document.createElement("span");
    selectionState.className = "mobile-stop-choice-state";
    const selected = isStopSelected(marker);
    button.classList.toggle("selected", selected);
    selectionState.textContent = selected ? "Selected · tap to deselect" : "Tap to select";

    button.append(address, detail, selectionState);
    button.addEventListener("click", () => {
      toggleIndividualStopSelection(marker);
      picker.hidden = true;
      updateSelectionCount();
      updateUndoButtonState();
    });
    list.appendChild(button);
  });

  picker.hidden = false;
}

function handleMobileStopTap(latlng) {
  const nearby = getNearbyVisibleStops(latlng);
  if (!nearby.length) {
    document.getElementById("mobileStopPicker").hidden = true;
    return;
  }

  if (nearby.length > 1 && nearby[1].distance - nearby[0].distance < 12) {
    showNearbyStopPicker(nearby);
    return;
  }

  const marker = nearby[0].marker;
  toggleIndividualStopSelection(marker);
  document.getElementById("mobileStopPicker").hidden = true;
  updateSelectionCount();
  updateUndoButtonState();
}

map.on("click", event => {
  if (event.layer) return;
  if (mobileStopSelectionMode && window.innerWidth <= 900) {
    handleMobileStopTap(event.latlng);
  }
});

map.on("popupopen", event => {
  if (mobileStopSelectionMode && window.innerWidth <= 900) {
    map.closePopup(event.popup);
    requestAnimationFrame(() => {
      if (mobileStopSelectionMode && window.innerWidth <= 900) map.closePopup();
    });
  }
});

map.on("tooltipopen", event => {
  if (mobileStopSelectionMode && window.innerWidth <= 900) {
    map.closeTooltip(event.tooltip);
  }
});

function restoreMarkerStyle(marker, key) {
  const isDelivered = String(marker._rowRef?.del_status || "").trim().toLowerCase() === "delivered";
  const color = isDelivered ? "#00FF00" : (symbolMap[key]?.color || marker._base?.symbol?.color);
  if (color) {
    marker.setStyle?.({
      color,
      fillColor: color,
      fillOpacity: isDelivered ? 1 : 0.95,
      opacity: 1,
      weight: 1
    });
  }
}

function updateSelectionCount() {
  const selection = drawnLayer.getLayers()[0];
  if (!selection) {
    highlightedMarkers.forEach(marker => {
      if (!individuallySelectedMarkers.has(marker)) {
        restoreMarkerStyle(marker, "");
        highlightedMarkers.delete(marker);
      }
    });
    individuallySelectedMarkers.forEach(marker => {
      if (!highlightedMarkers.has(marker)) {
        highlightSelectedMarker(marker);
        highlightedMarkers.add(marker);
      }
    });
    const visibleSelected = [...individuallySelectedMarkers].filter(marker => map.hasLayer(marker));
    document.getElementById("selectionCount").textContent = visibleSelected.length;
    updatePendingDeliveryCount(visibleSelected);
    return;
  }

  const selected = new Set();
  const selectionTester = createSelectionTester();

  Object.entries(routeDayGroups).forEach(([key, group]) => {
    group.layers.forEach(marker => {
      if (isStopSelected(marker, selectionTester)) {
        selected.add(marker);
        if (!highlightedMarkers.has(marker)) {
          highlightSelectedMarker(marker);
          highlightedMarkers.add(marker);
        }
      } else if (highlightedMarkers.has(marker)) {
        restoreMarkerStyle(marker, key);
        highlightedMarkers.delete(marker);
      }
    });
  });

  document.getElementById("selectionCount").textContent = selected.size;
  updatePendingDeliveryCount(selected);
}

function highlightSelectedMarker(marker) {
  marker.setStyle?.({
    color: "#ffd54a",
    fillColor: "#ffd54a",
    fillOpacity: 1,
    opacity: 1,
    weight: 3
  });
}


// ===== COMPLETE SELECTED STOPS =====


  


// ===== WHEN POLYGON IS DRAWN =====
map.on(L.Draw.Event.CREATED, e => {
  drawnLayer.clearLayers();
  individuallyDeselectedMarkers.clear();
  drawnLayer.addLayer(e.layer);
  updateSelectionCount();
  updateUndoButtonState();   // 🔥 ADD THIS
});

map.on(L.Draw.Event.EDITED, () => {
  updateSelectionCount();
  updateUndoButtonState();
});

map.on(L.Draw.Event.DELETED, () => {
  individuallyDeselectedMarkers.clear();
  updateSelectionCount();
  updateUndoButtonState();
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

function normalizeDayToken(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  const dayMap = {
    "1": "1", "mon": "1", "monday": "1",
    "2": "2", "tue": "2", "tues": "2", "tuesday": "2",
    "3": "3", "wed": "3", "wednesday": "3",
    "4": "4", "thu": "4", "thur": "4", "thurs": "4", "thursday": "4",
    "5": "5", "fri": "5", "friday": "5",
    "6": "6", "sat": "6", "saturday": "6",
    "7": "7", "sun": "7", "sunday": "7"
  };
  return dayMap[s] || s;
}

function getLayerLatLng(layer) {
  if (!layer) return null;
  if (typeof layer.getLatLng === "function") return layer.getLatLng();
  if (typeof layer.getBounds === "function") return layer.getBounds().getCenter();
  if (layer._base && Number.isFinite(layer._base.lat) && Number.isFinite(layer._base.lon)) {
    return L.latLng(layer._base.lat, layer._base.lon);
  }
  return null;
}

// Used by the visualization popup window (window.opener) to focus the matching route+day on the map.
window.highlightRouteDayOnMap = function(routeValue, dayValue) {
  const routeToken = String(routeValue ?? "").trim();
  const dayToken = normalizeDayToken(dayValue);
  if (!routeToken || !dayToken) {
    return { ok: false, message: "Route/day value is missing." };
  }

  let matchingKey = null;
  Object.keys(routeDayGroups).forEach(key => {
    if (matchingKey) return;
    const [kRoute, kDay] = key.split("|");
    if (!kRoute || !kDay || kDay === "Delivered") return;
    if (String(kRoute).trim() !== routeToken) return;

    const keyDayToken = normalizeDayToken(kDay);
    if (keyDayToken === dayToken) matchingKey = key;
  });

  if (!matchingKey || !routeDayGroups[matchingKey]) {
    return { ok: false, message: `Could not find ${routeToken} | ${dayValue} on the map.` };
  }

  const group = routeDayGroups[matchingKey];
  const markers = group.layers || [];
  if (!markers.length) {
    return { ok: false, message: `No map points found for ${routeToken} | ${dayValue}.` };
  }

  layerVisibilityState[matchingKey] = true;
  const layerCheckbox = document.querySelector(`input[data-key="${matchingKey}"]`);
  if (layerCheckbox) layerCheckbox.checked = true;

  const bounds = L.latLngBounds();
  markers.forEach(marker => {
    map.addLayer(marker);
    const ll = getLayerLatLng(marker);
    if (ll) bounds.extend(ll);

    const sym = symbolMap[matchingKey] || { color: "#2f89df" };
    marker.setStyle?.({
      color: "#ffd54a",
      fillColor: "#ffd54a",
      fillOpacity: 1,
      opacity: 1,
      weight: 2
    });

    setTimeout(() => {
      marker.setStyle?.({
        color: sym.color,
        fillColor: sym.color,
        fillOpacity: 0.95,
        opacity: 1,
        weight: 1
      });
    }, 2200);
  });

  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  return {
    ok: true,
    message: `Highlighted ${matchingKey} on the map.`,
    key: matchingKey,
    points: markers.length
  };
};


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

  const size = steps.find(([max]) => z <= max)[1];
  if (!window.matchMedia("(max-width: 900px)").matches) return size;
  if (z >= 15) return Math.max(size, 8);
  if (z >= 13) return Math.max(size, 6);
  if (z >= 11) return Math.max(size, 4);
  if (z >= 8) return Math.max(size, 3);
  return size;
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

  updateSelectionCount();
  updateUndoButtonState();
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

  updateSelectionCount();
  updateUndoButtonState();
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
  if (!deliverySaveInProgress) setDeliverySaveStatus("idle", "");

  // Clear previous map data
  Object.values(routeDayGroups).forEach(g => g.layers.forEach(l => map.removeLayer(l)));
  drawnLayer.clearLayers();
  individuallySelectedMarkers.clear();
  individuallyDeselectedMarkers.clear();
  highlightedMarkers.clear();
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
    marker.on("click", event => {
      if (mobileStopSelectionMode && window.innerWidth <= 900) {
        L.DomEvent.stop(event.originalEvent || event);
        map.closePopup();
        handleMobileStopTap(event.latlng || marker.getLatLng());
        return;
      }

      toggleIndividualStopSelection(marker);
      updateSelectionCount();
      updateUndoButtonState();
    });

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
const CART_DELIVERY_FILES_KEY = "cartdelivery.savedFiles.cartDelivery";
let cartDeliveryFileNames = new Set();
try {
  const storedFileNames = JSON.parse(localStorage.getItem(CART_DELIVERY_FILES_KEY) || "[]");
  if (Array.isArray(storedFileNames)) {
    cartDeliveryFileNames = new Set(storedFileNames.filter(name => typeof name === "string"));
  } else {
    console.error("Saved Cart Delivery file organization has an invalid format.");
  }
} catch (error) {
  console.error("Could not read Cart Delivery file organization:", error);
}
let activeSavedFilesTab = "cartDelivery";

function saveCartDeliveryFileNames() {
  try {
    localStorage.setItem(CART_DELIVERY_FILES_KEY, JSON.stringify([...cartDeliveryFileNames]));
  } catch (error) {
    console.error("Could not save Cart Delivery file organization:", error);
    alert("Could not save this file organization in this browser.");
  }
}

function setSavedFilesTab(tab) {
  activeSavedFilesTab = tab;
  const cartDeliveryTab = document.getElementById("cartDeliveryFilesTab");
  const allFilesTab = document.getElementById("allSavedFilesTab");
  const panel = document.getElementById("savedFiles");
  const isCartDelivery = tab === "cartDelivery";

  cartDeliveryTab.classList.toggle("active", isCartDelivery);
  cartDeliveryTab.setAttribute("aria-selected", String(isCartDelivery));
  allFilesTab.classList.toggle("active", !isCartDelivery);
  allFilesTab.setAttribute("aria-selected", String(!isCartDelivery));
  panel.setAttribute("aria-labelledby", isCartDelivery ? "cartDeliveryFilesTab" : "allSavedFilesTab");
  listFiles();
}

document.getElementById("cartDeliveryFilesTab")
  .addEventListener("click", () => setSavedFilesTab("cartDelivery"));
document.getElementById("allSavedFilesTab")
  .addEventListener("click", () => setSavedFilesTab("all"));

async function listFiles() {
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) {
    console.error("Could not list saved files:", error);
    alert("Could not load saved files. Please try again.");
    return;
  }

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
  const visibleRouteKeys = Object.keys(routeFiles).filter(key =>
    activeSavedFilesTab === "all" || cartDeliveryFileNames.has(routeFiles[key])
  );

  if (!visibleRouteKeys.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "saved-files-empty";
    emptyState.textContent = activeSavedFilesTab === "cartDelivery"
      ? "No Cart Delivery files yet. Open All Files and add files here."
      : "No saved Excel files found.";
    ul.appendChild(emptyState);
    return;
  }

  visibleRouteKeys.forEach(key => {
    const routeName = routeFiles[key];
    const summaryName = summaryFiles[key];

    const li = document.createElement("li");

    const fileName = document.createElement("span");
    fileName.className = "saved-file-name";
    fileName.textContent = routeName;
    li.appendChild(fileName);

    const organizeBtn = document.createElement("button");
    organizeBtn.className = "saved-file-organize-btn";
    const isCartDeliveryFile = cartDeliveryFileNames.has(routeName);
    organizeBtn.textContent = isCartDeliveryFile ? "Remove from Cart Delivery" : "Add to Cart Delivery";
    organizeBtn.setAttribute("aria-pressed", String(isCartDeliveryFile));
    organizeBtn.onclick = () => {
      if (cartDeliveryFileNames.has(routeName)) {
        cartDeliveryFileNames.delete(routeName);
      } else {
        cartDeliveryFileNames.add(routeName);
      }
      saveCartDeliveryFileNames();
      listFiles();
    };
    li.appendChild(organizeBtn);

    // OPEN MAP
    const openBtn = document.createElement("button");
    openBtn.className = "saved-file-btn";
    openBtn.textContent = "Open Map";
   openBtn.onclick = async () => {
  try {

    showLoading("Loading Excel file...");

    const { data } = sb.storage.from(BUCKET).getPublicUrl(routeName);

    const urlWithBypass = data.publicUrl + "?v=" + Date.now();

    const r = await fetch(urlWithBypass, {
      cache: "no-store"
    });

    window._currentFilePath = routeName;
    setCurrentFileDisplay(window._currentFilePath);

    processExcelBuffer(await r.arrayBuffer());
    await loadSummaryFor(routeName);

    hideLoading("File Loaded Successfully ✅");
    if (fileManagerModal) fileManagerModal.style.display = "none";

  } catch (err) {
    console.error(err);
    hideLoading();
    alert("Error loading file.");
  }
};



    li.appendChild(openBtn);

    // SUMMARY BUTTON
    if (summaryName) {
      const summaryBtn = document.createElement("button");
      summaryBtn.textContent = "Summary";
      summaryBtn.style.marginLeft = "5px";
      summaryBtn.onclick = async () => {
        await loadSummaryFor(routeName);
        if (fileManagerModal) fileManagerModal.style.display = "none";
      };
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

  const { error } = await sb.storage.from(BUCKET).remove(toDelete);
  if (error) {
    console.error("Could not delete saved file:", error);
    alert("Could not delete this file. Please try again.");
    return;
  }

  cartDeliveryFileNames.delete(routeName);
  saveCartDeliveryFileNames();
  alert("✅ File deleted successfully.");
  listFiles();
};


    li.appendChild(delBtn);
    ul.appendChild(li);
  });
}


// ================= UPLOAD FILE =================
async function uploadFile(file) {
  if (!file) return;

  try {

    showLoading("Uploading file...");

    const { error } = await sb.storage
      .from(BUCKET)
      .upload(file.name, file, { upsert: true });

    if (error) {
      throw error;
    }

    window._currentFilePath = file.name;
    setCurrentFileDisplay(window._currentFilePath);

    processExcelBuffer(await file.arrayBuffer());
    listFiles();

    hideLoading("Upload Complete ✅");

  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    hideLoading();
    alert("Upload failed: " + error.message);
  }
}

// ================= ROUTE SUMMARY DISPLAY =================
function showRouteSummary(rows, headers)
 {
  const tableBox = document.getElementById("routeSummaryTable");
  const panel = document.getElementById("bottomSummary");
  const btn = document.getElementById("summaryToggleBtn");

  if (!tableBox || !panel || !btn) return;

  tableBox.innerHTML = "";
  window._summaryRows = Array.isArray(rows) ? rows : [];
  window._summaryHeaders = Array.isArray(headers) ? headers : [];

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

function autoCollapseSidebarsForSummary() {
  const appContainer = document.querySelector(".app-container");
  const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector(".mobile-overlay");
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");

  const selectionBox = document.getElementById("selectionBox");
  const toggleSelectionBtn = document.getElementById("toggleSelectionBtn");

  // Left sidebar: collapse desktop and close mobile drawer.
  if (appContainer) appContainer.classList.add("collapsed");
  if (toggleSidebarBtn) toggleSidebarBtn.setAttribute("aria-expanded", "false");
  if (sidebar) sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("show");
  if (mobileMenuBtn) mobileMenuBtn.textContent = "☰";

  // Right sidebar: collapse desktop and hide mobile panel.
  if (selectionBox) {
    selectionBox.classList.add("collapsed");
    selectionBox.classList.remove("show");
  }
  if (toggleSelectionBtn) toggleSelectionBtn.textContent = "❮";

  setTimeout(() => map.invalidateSize(), 180);
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
autoCollapseSidebarsForSummary();


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
  const saveStatus = document.getElementById("deliverySaveStatus");

  if (!locateBtn || !completeBtn || !headerContainer || !desktopContainer) return;

  if (window.innerWidth <= 900) {
    // 📱 MOBILE
    headerContainer.appendChild(locateBtn);
    headerContainer.appendChild(completeBtn);
    if (undoBtn) headerContainer.appendChild(undoBtn);

    if (streetToggle) {
      headerContainer.appendChild(streetToggle.parentElement);
    }

    headerContainer.appendChild(saveStatus);

  } else {
    // 🖥 DESKTOP
    desktopContainer.appendChild(locateBtn);
    desktopContainer.appendChild(completeBtn);
    if (undoBtn) desktopContainer.appendChild(undoBtn);

    if (streetToggle) {
      desktopContainer.appendChild(streetToggle.parentElement);
    }

    desktopContainer.insertBefore(saveStatus, completeBtn.nextSibling);
  }
  updateDeliveryButtons();
}

//undo button state
function updateUndoButtonState() {
  const undoBtn = document.getElementById("undoDeliveredBtn");
  if (!undoBtn) return;

  const hasPolygon = Boolean(drawnLayer.getLayers()[0]);
  const selectionTester = createSelectionTester();
  const candidates = hasPolygon
    ? Object.entries(routeDayGroups)
      .filter(([key]) => key.endsWith("|Delivered"))
      .flatMap(([, group]) => group.layers)
    : [...individuallySelectedMarkers];
  const hasDeliveredInSelection = candidates.some(marker =>
    marker._rowRef &&
    String(marker._rowRef.del_status || "").trim().toLowerCase() === "delivered" &&
    isStopSelected(marker, selectionTester)
  );

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
const pageHeader = document.querySelector("header");

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

function syncSelectionBoxTop() {
  if (!selectionBox || !pageHeader) return;
  const headerHeight = Math.ceil(pageHeader.getBoundingClientRect().height);
  if (window.innerWidth <= 900) {
    selectionBox.style.top = "";
    selectionBox.style.maxHeight = "";
    if (toggleSelectionBtn) toggleSelectionBtn.style.top = "";
    return;
  }

  // Keep sidebar fully below sticky header on desktop.
  const topOffset = headerHeight + 8;
  selectionBox.style.top = `${topOffset}px`;
  selectionBox.style.maxHeight = `calc(100vh - ${topOffset + 12}px)`;
  if (toggleSelectionBtn) toggleSelectionBtn.style.top = `${topOffset + 8}px`;
}

syncSelectionBoxTop();
window.addEventListener("resize", syncSelectionBoxTop);

// Clear selection button (ALWAYS ACTIVE)
if (clearBtn) {
clearBtn.onclick = () => {
  // Remove polygon
  drawnLayer.clearLayers();
  individuallySelectedMarkers.clear();
  individuallyDeselectedMarkers.clear();

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

["dragenter", "dragover"].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.add("drag-active"));
});

["dragleave", "drop"].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove("drag-active"));
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
    toggleSidebarBtn.setAttribute(
      "aria-expanded",
      appContainer.classList.contains("collapsed") ? "false" : "true"
    );

    toggleSidebarBtn.addEventListener("click", () => {
      appContainer.classList.toggle("collapsed");
      toggleSidebarBtn.setAttribute(
        "aria-expanded",
        appContainer.classList.contains("collapsed") ? "false" : "true"
      );
      setTimeout(() => map.invalidateSize(), 200);
    });
  }

// ===== MOBILE MENU =====
const mobileMenuBtn = document.getElementById("mobileMenuBtn");

const overlay = document.querySelector(".mobile-overlay");

function syncMobileSidebarLayout() {
  if (!sidebar || !pageHeader) return;

  if (window.innerWidth <= 900) {
    const headerHeight = Math.ceil(pageHeader.getBoundingClientRect().height);
    sidebar.style.top = `${headerHeight}px`;
    sidebar.style.height = `calc(100dvh - ${headerHeight}px)`;
  } else {
    sidebar.style.top = "";
    sidebar.style.height = "";
  }
}

syncMobileSidebarLayout();
window.addEventListener("resize", syncMobileSidebarLayout);

// Anchor mobile selection actions to the summary's actual height, including
// the iPhone home-indicator inset and changes while resizing the summary.
const mobileSummaryPanel = document.getElementById("bottomSummary");
function syncMobileSelectionLayout() {
  if (window.innerWidth > 900) return;
  const root = document.documentElement;
  root.style.setProperty("--mobile-summary-height", `${mobileSummaryPanel.offsetHeight}px`);
  root.style.setProperty("--mobile-header-height", `${pageHeader.offsetHeight}px`);
}

const mobileLayoutObserver = new ResizeObserver(() => {
  syncMobileSelectionLayout();
  syncMobileSidebarLayout();
  syncSelectionBoxTop();
  map.invalidateSize({ pan: false });
});
mobileLayoutObserver.observe(mobileSummaryPanel);
mobileLayoutObserver.observe(pageHeader);
window.addEventListener("resize", syncMobileSelectionLayout);
syncMobileSelectionLayout();

if (mobileMenuBtn && sidebar && overlay) {

  mobileMenuBtn.addEventListener("click", () => {
    syncMobileSidebarLayout();
    const open = sidebar.classList.toggle("open");

    mobileMenuBtn.textContent = open ? "✕" : "☰";
    overlay.classList.toggle("show", open);
    if (open) {
      sidebar.scrollTop = 0;
      requestAnimationFrame(() => {
        sidebar.scrollTop = 0;
      });
    }

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
  function setMobileStopSelectionMode(isActive) {
    mobileStopSelectionMode = isActive;
    document.body.classList.toggle("mobile-stop-selection-mode", isActive);
    mobileSelBtn.classList.toggle("selection-mode", isActive);
    document.getElementById("mobileStopPicker").hidden = true;
    if (isActive) map.closePopup();
    if (isActive) selectionBox.classList.remove("show");
    updateSelectionCount();
  }

  mobileSelBtn.addEventListener("click", () => {
    const selectedCount = Number(document.getElementById("selectionCount").textContent);
    if (mobileStopSelectionMode) {
      setMobileStopSelectionMode(false);
      if (selectedCount) selectionBox.classList.add("show");
      return;
    }

    if (selectionBox.classList.contains("show")) {
      selectionBox.classList.remove("show");
    } else if (selectedCount) {
      selectionBox.classList.add("show");
      return;
    }

    setMobileStopSelectionMode(true);
  });

  document.getElementById("mobileStopPickerClose").addEventListener("click", () => {
    document.getElementById("mobileStopPicker").hidden = true;
  });

  // keep count synced
  const originalUpdate = updateSelectionCount;
  updateSelectionCount = function () {
    originalUpdate();
    const count = Number(document.getElementById("selectionCount").textContent);
    mobileSelBtn.textContent = mobileStopSelectionMode
      ? `Done · ${count}`
      : count
        ? `Selected: ${count}`
        : "Select Stops";
    mobileSelBtn.setAttribute(
      "aria-label",
      mobileStopSelectionMode
        ? `Finish selecting ${count} stops`
        : count
          ? `Open actions for ${count} selected stops`
          : "Start tap selection for closely spaced stops"
    );
    mobileSelBtn.title = mobileStopSelectionMode
      ? "Tap stops on the map, then tap here when finished."
      : "Start precise tap selection, or open actions for selected stops.";
  };
  updateSelectionCount();
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

    // Start collapsed on initial load (desktop + mobile)
    panel.classList.add("collapsed");
    panel.style.height = "40px";
    if (toggleBtn) toggleBtn.textContent = "▲";

    // Drag resize (mouse + touch/pen) while preserving button clicks in header
    header.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      isDragging = true;
      startY = e.clientY;
      startHeight = panel.offsetHeight;
      document.body.style.userSelect = "none";
    });

    document.addEventListener("pointermove", e => {
      if (!isDragging) return;

      const delta = startY - e.clientY;
      let newHeight = startHeight + delta;

      const minHeight = 40;
      const maxHeight = window.innerHeight - 100;

      newHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
      panel.style.height = newHeight + "px";
    });

    document.addEventListener("pointerup", () => {
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
              :root {
                --bg: #f3f7fb;
                --panel: #ffffff;
                --line: #d6e2ee;
                --head: #e9f2fb;
                --text: #16324d;
                --muted: #4e6a86;
                --accent: #2f89df;
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                padding: 18px;
                background: radial-gradient(circle at 10% 0%, #eaf2fb 0%, var(--bg) 42%);
                color: var(--text);
                font-family: "Segoe UI", Roboto, Arial, sans-serif;
              }
              .summary-shell {
                max-width: 1300px;
                margin: 0 auto;
                background: var(--panel);
                border: 1px solid var(--line);
                border-radius: 14px;
                box-shadow: 0 14px 30px rgba(16, 42, 68, 0.12);
                overflow: hidden;
              }
              .summary-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 14px;
                border-bottom: 1px solid var(--line);
                background: linear-gradient(180deg, #f9fcff 0%, #eef5fc 100%);
              }
              .summary-title {
                margin: 0;
                font-size: 18px;
                font-weight: 700;
                letter-spacing: 0.01em;
              }
              .summary-note {
                font-size: 12px;
                color: var(--muted);
              }
              .summary-table-wrap {
                max-height: calc(100vh - 140px);
                overflow: auto;
              }
              table {
                border-collapse: separate;
                border-spacing: 0;
                width: 100%;
                font-size: 13px;
              }
              th, td {
                border-right: 1px solid var(--line);
                border-bottom: 1px solid var(--line);
                padding: 8px 10px;
                text-align: left;
                white-space: nowrap;
              }
              th {
                position: sticky;
                top: 0;
                z-index: 1;
                background: var(--head);
                color: var(--text);
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.03em;
              }
              tr:nth-child(even) td {
                background: #f8fbff;
              }
              tr:hover td {
                background: #edf5ff;
              }
              th:first-child, td:first-child { border-left: 1px solid var(--line); }
            </style>
          </head>
          <body>
            <div class="summary-shell">
              <div class="summary-header">
                <h2 class="summary-title">Route Summary</h2>
                <span class="summary-note">Scroll to view all columns and rows</span>
              </div>
              <div class="summary-table-wrap">
                ${tableHTML}
              </div>
            </div>
          </body>
        </html>
      `);

      win.document.close();
    };
  }

  // ===== SUMMARY VISUALIZATION WINDOW =====
  const visualizeBtn = document.getElementById("visualizeSummaryBtn");

  if (visualizeBtn) {
    visualizeBtn.onclick = () => {
      const rows = window._summaryRows || [];
      const headers = window._summaryHeaders || [];

      if (!rows.length || !headers.length) {
        alert("No route summary loaded.");
        return;
      }

      const toNumber = v => {
        if (v === null || v === undefined) return NaN;
        const s = String(v).replace(/,/g, "").trim();
        if (!s) return NaN;
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
      };
      const toHours = v => {
        if (v === null || v === undefined) return NaN;
        if (typeof v === "number" && Number.isFinite(v)) {
          // Excel time values may be stored as fractions of a day.
          if (v > 0 && v < 1) return v * 24;
          return v;
        }

        const s = String(v).trim();
        if (!s) return NaN;

        const direct = toNumber(s);
        if (Number.isFinite(direct)) {
          if (direct > 0 && direct < 1) return direct * 24;
          return direct;
        }

        // HH:MM or HH:MM:SS
        const colonMatch = s.match(/^(-?\d+):(\d{1,2})(?::(\d{1,2}))?$/);
        if (colonMatch) {
          const h = Number(colonMatch[1]) || 0;
          const m = Number(colonMatch[2]) || 0;
          const sec = Number(colonMatch[3] || 0) || 0;
          return h + m / 60 + sec / 3600;
        }

        // "11h 30m", "11 hr", "45 min"
        const lower = s.toLowerCase();
        const hMatch = lower.match(/(-?\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)/);
        const mMatch = lower.match(/(-?\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)/);
        if (hMatch || mMatch) {
          const h = hMatch ? Number(hMatch[1]) : 0;
          const m = mMatch ? Number(mMatch[1]) : 0;
          return (Number.isFinite(h) ? h : 0) + (Number.isFinite(m) ? m : 0) / 60;
        }

        return NaN;
      };

      const escapeHtml = value =>
        String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;")
          .replace(/'/g, "&#39;");
      const normalize = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedHeaders = headers.map(h => ({ original: h, norm: normalize(h) }));

      function findHeader(candidates) {
        const direct = normalizedHeaders.find(h => candidates.includes(h.norm));
        if (direct) return direct.original;

        const loose = normalizedHeaders.find(h =>
          candidates.some(c => h.norm.includes(c) || c.includes(h.norm))
        );
        return loose ? loose.original : null;
      }

      const fieldSpec = [
        { key: "route", label: "Route", aliases: ["route", "newroute", "routeid", "rte"] },
        { key: "day", label: "Day", aliases: ["day", "routeday", "dispatchday", "newday"] },
        { key: "start", label: "Start Location", aliases: ["startlocation", "start", "origin", "startdepot", "startfacility"] },
        { key: "end", label: "End Location", aliases: ["endlocation", "end", "destination", "enddepot", "endfacility"] },
        { key: "stops", label: "Total Stops", aliases: ["totalstops", "stops", "stopcount", "numberofstops"] },
        { key: "breakTime", label: "Break Time", aliases: ["breaktime", "totbreaktime", "totalbreaktime", "break"] },
        { key: "facilityTime", label: "Facility Time", aliases: ["facilitytime", "totfacilitytime", "totalfacilitytime"] },
        { key: "totalTime", label: "Total Time", aliases: ["totaltime", "totalroutetime", "routetime", "hours"] },
        { key: "miles", label: "Miles", aliases: ["miles", "totalmiles", "route miles", "distance", "distancemiles"] },
        { key: "demand", label: "Demand", aliases: ["demand", "totaldemand", "volume", "load"] },
        { key: "trips", label: "Number of Trips", aliases: ["numberoftrips", "trips", "tripcount", "totaltrips"] }
      ];

      const selectedHeaders = {};
      fieldSpec.forEach(f => {
        selectedHeaders[f.key] = findHeader(f.aliases.map(normalize));
      });

      const focusedRows = rows.map(r => {
        const out = {};
        fieldSpec.forEach(f => {
          const h = selectedHeaders[f.key];
          out[f.key] = h ? r[h] : "";
        });
        return out;
      });

      // Aggregate at route+day level so the visualization centers on route/day units.
      const routeDayMap = new Map();
      focusedRows.forEach(r => {
        const route = String(r.route || "").trim() || "Unknown Route";
        const day = String(r.day || "").trim() || "Unknown Day";
        const key = `${route} | ${day}`;
        if (!routeDayMap.has(key)) {
          routeDayMap.set(key, {
            route,
            day,
            routeDay: key,
            start: String(r.start || "").trim(),
            end: String(r.end || "").trim(),
            stops: 0,
            breakTime: 0,
            facilityTime: 0,
            totalTime: 0,
            miles: 0,
            demand: 0,
            trips: 0
          });
        }
        const bucket = routeDayMap.get(key);

        const stops = toNumber(r.stops);
        const breakTime = toHours(r.breakTime);
        const facilityTime = toHours(r.facilityTime);
        const totalTime = toHours(r.totalTime);
        const miles = toNumber(r.miles);
        const demand = toNumber(r.demand);
        const trips = toNumber(r.trips);

        bucket.stops += Number.isFinite(stops) ? stops : 0;
        bucket.breakTime += Number.isFinite(breakTime) ? breakTime : 0;
        bucket.facilityTime += Number.isFinite(facilityTime) ? facilityTime : 0;
        bucket.totalTime += Number.isFinite(totalTime) ? totalTime : 0;
        bucket.miles += Number.isFinite(miles) ? miles : 0;
        bucket.demand += Number.isFinite(demand) ? demand : 0;
        bucket.trips += Number.isFinite(trips) ? trips : 0;

        if (!bucket.start && r.start) bucket.start = String(r.start);
        if (!bucket.end && r.end) bucket.end = String(r.end);
      });

      const routeDayRows = Array.from(routeDayMap.values());

      const dayTotalsMap = new Map();
      routeDayRows.forEach(r => {
        const day = r.day || "Unknown Day";
        if (!dayTotalsMap.has(day)) {
          dayTotalsMap.set(day, {
            day,
            routeDayCount: 0,
            demand: 0,
            miles: 0,
            stops: 0,
            trips: 0
          });
        }
        const d = dayTotalsMap.get(day);
        d.routeDayCount += 1;
        d.demand += r.demand;
        d.miles += r.miles;
        d.stops += r.stops;
        d.trips += r.trips;
      });

      const dayTotals = Array.from(dayTotalsMap.values()).sort((a, b) => b.routeDayCount - a.routeDayCount);

      function makeBars(items, labelKey, valueKey, alt, kind) {
        if (!items.length) return '<div class="empty">No data available.</div>';
        const max = Math.max(1, ...items.map(i => i[valueKey]));
        return items
          .slice()
          .sort((a, b) => b[valueKey] - a[valueKey])
          .map(i => `
            <div class="bar-row section-route-row" data-kind="${escapeHtml(kind || "")}" data-key="${encodeURIComponent(String(i[labelKey] ?? ""))}">
              <div class="bar-label">${escapeHtml(i[labelKey])}</div>
              <div class="bar-track ${alt ? "alt" : ""}"><div class="bar-fill ${alt ? "alt" : ""}" style="width:${(i[valueKey] / max) * 100}%"></div></div>
              <div class="bar-value">${i[valueKey].toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </div>
          `)
          .join("");
      }

      const dayDemandBars = makeBars(dayTotals, "day", "demand", false, "day");
      const dayMilesBars = makeBars(dayTotals, "day", "miles", true, "day");
      const dayStopsBars = makeBars(dayTotals, "day", "stops", false, "day");
      const dayTripsBars = makeBars(dayTotals, "day", "trips", true, "day");

      const totalDemand = routeDayRows.reduce((a, r) => a + r.demand, 0);
      const totalMiles = routeDayRows.reduce((a, r) => a + r.miles, 0);
      const totalStops = routeDayRows.reduce((a, r) => a + r.stops, 0);
      const topDemandDay = dayTotals.slice().sort((a, b) => b.demand - a.demand)[0]?.day || "N/A";
      const targetHours = 11;
      const totalTimeSum = routeDayRows.reduce((a, r) => a + r.totalTime, 0);
      const avgTotalTime = routeDayRows.length ? totalTimeSum / routeDayRows.length : 0;

      let overTargetCount = 0;
      let underOrAtTargetCount = 0;
      routeDayRows.forEach(r => {
        if (r.totalTime > targetHours) overTargetCount += 1;
        else underOrAtTargetCount += 1;
      });

      const timeTargetBars = makeBars(
        [
          { label: `Over ${targetHours} Hours`, count: overTargetCount },
          { label: `${targetHours} Hours or Less`, count: underOrAtTargetCount }
        ],
        "label",
        "count",
        true,
        "target"
      );

      const uniqueRoutes = new Set(routeDayRows.map(r => String(r.route || "").trim()).filter(Boolean)).size;
      const scatterDataJson = JSON.stringify(
        routeDayRows.map(r => ({
          routeDay: r.routeDay,
          route: r.route,
          day: r.day,
          stops: Number(r.stops) || 0,
          miles: Number(r.miles) || 0,
          totalTime: Number(r.totalTime) || 0
        }))
      ).replace(/</g, "\\u003c");

      const missingFields = fieldSpec
        .filter(f => !selectedHeaders[f.key])
        .map(f => f.label);

      const routeDayTable = routeDayRows
        .slice()
        .sort((a, b) => (a.day === b.day ? String(a.route).localeCompare(String(b.route)) : String(a.day).localeCompare(String(b.day))))
        .slice(0, 600)
        .map(r => `
          <tr>
            <td>${escapeHtml(r.route)}</td>
            <td>${escapeHtml(r.day)}</td>
            <td>${escapeHtml(r.start)}</td>
            <td>${escapeHtml(r.end)}</td>
            <td>${r.stops.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.breakTime.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.facilityTime.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.totalTime.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.miles.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.demand.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td>${r.trips.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
          </tr>
        `)
        .join("");

      const win = window.open("", "_blank", "width=1080,height=760,resizable=yes,scrollbars=yes");
      if (!win) return;

      win.document.write(`
        <html>
          <head>
            <title>Route Summary Visualization</title>
            <style>
              :root { --bg:#f3f7fb; --panel:#ffffff; --line:#d8e3ee; --text:#14314d; --muted:#4f6883; --a:#2f89df; --b:#20a38e; }
              * { box-sizing: border-box; }
              body { margin:0; padding:18px; font-family:"Segoe UI",Roboto,Arial,sans-serif; background:radial-gradient(circle at 10% 0%, #eaf2fb 0%, var(--bg) 45%); color:var(--text); }
              .shell { max-width:1200px; margin:0 auto; background:var(--panel); border:1px solid var(--line); border-radius:14px; box-shadow:0 14px 30px rgba(16,42,68,.12); overflow:hidden; }
              .head { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#f9fcff 0%,#eef5fc 100%); }
              .title { margin:0; font-size:18px; font-weight:700; }
              .meta { font-size:12px; color:var(--muted); }
              .grid { display:grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap:10px; padding:12px; border-bottom:1px solid var(--line); }
              .card { border:1px solid var(--line); border-radius:10px; padding:10px; background:#fbfdff; }
              .card-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
              .card-value { margin-top:4px; font-size:22px; font-weight:700; }
              .section { padding:12px; border-bottom:1px solid var(--line); }
              .section h3 { margin:0 0 10px 0; font-size:14px; }
              .bar-row { display:grid; grid-template-columns: 240px 1fr 120px; gap:10px; align-items:center; margin-bottom:8px; }
              .section-route-row { cursor:pointer; border-radius:8px; padding:4px 6px; margin-left:-6px; margin-right:-6px; }
              .section-route-row:hover { background:#f1f7ff; }
              .bar-label { font-size:12px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
              .bar-track { height:12px; border-radius:999px; background:#e5eef8; overflow:hidden; }
              .bar-fill { height:100%; background:linear-gradient(90deg,#47a2f8 0%,var(--a) 100%); }
              .bar-track.alt { background:#e8f5f2; }
              .bar-fill.alt { background:linear-gradient(90deg,#36c3ab 0%,var(--b) 100%); }
              .bar-value { text-align:right; font-size:12px; color:var(--muted); font-weight:700; }
              .empty { color:var(--muted); font-size:13px; }
              .note { margin: 0 0 10px 0; color: var(--muted); font-size: 12px; }
              .legend { display:flex; gap:14px; align-items:center; margin: 0 0 10px 0; color:var(--muted); font-size:12px; flex-wrap:wrap; }
              .dot { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:6px; vertical-align:middle; }
              .dot-blue { background:#2f89df; }
              .dot-red { background:#e25b53; }
              .chart-wrap { border:1px solid var(--line); border-radius:10px; background:#fff; padding:8px; overflow:auto; }
              .chart-controls { display:flex; gap:10px; flex-wrap:wrap; margin:0 0 10px 0; }
              .chart-controls label { font-size:12px; color:var(--muted); display:flex; gap:6px; align-items:center; }
              .chart-controls select, .chart-controls input { border:1px solid #c8d8e8; border-radius:8px; padding:6px 8px; font-size:12px; }
              .scatter-tooltip { position:fixed; pointer-events:none; background:#102a44; color:#fff; padding:8px 10px; border-radius:8px; font-size:12px; z-index:99999; box-shadow:0 10px 24px rgba(0,0,0,.22); display:none; white-space:nowrap; }
              .chart-toast { position:fixed; right:18px; bottom:18px; z-index:99999; background:#1f7a3f; color:#fff; border-radius:10px; padding:9px 12px; font-size:12px; box-shadow:0 10px 24px rgba(0,0,0,.2); opacity:0; transform:translateY(8px); transition:opacity .2s ease, transform .2s ease; pointer-events:none; }
              .chart-toast.show { opacity:1; transform:translateY(0); }
              .chart-toast.error { background:#a83f3a; }
              .section-modal { position:fixed; inset:0; background:rgba(16,42,68,.45); display:flex; align-items:center; justify-content:center; padding:18px; z-index:99998; }
              .section-modal.hidden { display:none; }
              .section-modal-card { width:min(760px, 100%); max-height:80vh; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 18px 36px rgba(16,42,68,.25); }
              .section-modal-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--line); background:#f7fbff; }
              .section-modal-title { margin:0; font-size:14px; }
              .section-modal-close { border:1px solid #b7cce1; background:#fff; border-radius:8px; padding:5px 10px; cursor:pointer; }
              .section-modal-body { padding:10px 12px; max-height:calc(80vh - 52px); overflow:auto; }
              .section-modal-list { margin:0; padding-left:18px; }
              .section-modal-list li { margin:6px 0; font-size:13px; }
              .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:10px; background:#fff; }
              table { width:100%; border-collapse:collapse; min-width:1160px; }
              th, td { border-bottom:1px solid var(--line); border-right:1px solid var(--line); padding:8px 10px; text-align:left; font-size:12px; white-space:nowrap; }
              th { position:sticky; top:0; background:#f4f9ff; z-index:2; text-transform:uppercase; letter-spacing:.03em; font-size:11px; }
              tr:nth-child(even) td { background:#fbfdff; }
              tr:hover td { background:#eef6ff; }
              @media (max-width: 980px) {
                .grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
                .bar-row { grid-template-columns: 170px 1fr 90px; }
              }
            </style>
          </head>
          <body>
            <div class="shell">
              <div class="head">
                <h2 class="title">Route Summary Visualization</h2>
                <span class="meta">Rows: ${rows.length.toLocaleString()} | Columns: ${headers.length.toLocaleString()}</span>
              </div>
              <div class="grid">
                <div class="card"><div class="card-label">Total Routes</div><div class="card-value">${uniqueRoutes.toLocaleString()}</div></div>
                <div class="card"><div class="card-label">Avg Total Time</div><div class="card-value">${avgTotalTime.toLocaleString(undefined, { maximumFractionDigits: 2 })}h</div></div>
                <div class="card"><div class="card-label">Over 11h</div><div class="card-value">${overTargetCount.toLocaleString()}</div></div>
                <div class="card"><div class="card-label">11h or Less</div><div class="card-value">${underOrAtTargetCount.toLocaleString()}</div></div>
              </div>
              <div class="section">
                <h3>Stops vs Miles by Route + Day</h3>
                <p class="note">Use filters below and hover any point to see details. Red points are over the 11-hour total-time target.</p>
                <div class="chart-controls">
                  <label>Day
                    <select id="scatterDayFilter">
                      <option value="all">All Days</option>
                    </select>
                  </label>
                  <label><input type="checkbox" id="scatterOverOnly" /> Show only over 11h</label>
                </div>
                <div class="legend">
                  <span><span class="dot dot-blue"></span>At or under ${targetHours}h total time</span>
                  <span><span class="dot dot-red"></span>Over ${targetHours}h total time</span>
                </div>
                <div id="stopsMilesScatterHost" class="chart-wrap"></div>
                <div id="scatterTooltip" class="scatter-tooltip"></div>
                <div id="chartToast" class="chart-toast"></div>
              </div>
              <div class="section">
                <h3>Total Time vs ${targetHours}-Hour Target</h3>
                <p class="note">Average total time per route+day: ${avgTotalTime.toLocaleString(undefined, { maximumFractionDigits: 2 })} hours</p>
                ${timeTargetBars}
              </div>
              <div class="section">
                <h3>Distribution of Demand Per Day</h3>
                ${dayDemandBars}
              </div>
              <div class="section">
                <h3>Distribution of Miles Per Day</h3>
                ${dayMilesBars}
              </div>
              <div class="section">
                <h3>Distribution of Stops Per Day</h3>
                ${dayStopsBars}
              </div>
              <div class="section">
                <h3>Distribution of Trips Per Day</h3>
                ${dayTripsBars}
              </div>
              <div class="section">
                <h3>Route + Day Detail</h3>
                <p class="note">Each row below is grouped by route and day to make day-level performance easier to interpret.</p>
                ${missingFields.length ? `<p class="note">Missing in this file: ${escapeHtml(missingFields.join(", "))}</p>` : ""}
                <p class="note">Totals: Stops ${totalStops.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Demand ${totalDemand.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Miles ${totalMiles.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th>Day</th>
                        <th>Start Location</th>
                        <th>End Location</th>
                        <th>Total Stops</th>
                        <th>Break Time</th>
                        <th>Facility Time</th>
                        <th>Total Time</th>
                        <th>Miles</th>
                        <th>Demand</th>
                        <th>Number of Trips</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${routeDayTable || '<tr><td colspan="11">No route rows found.</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div id="sectionRouteDayModal" class="section-modal hidden">
              <div class="section-modal-card">
                <div class="section-modal-head">
                  <h4 id="sectionRouteDayTitle" class="section-modal-title">Route+Day List</h4>
                  <button id="sectionRouteDayClose" class="section-modal-close">Close</button>
                </div>
                <div class="section-modal-body">
                  <ul id="sectionRouteDayList" class="section-modal-list"></ul>
                </div>
              </div>
            </div>
            <script>
              (() => {
                const data = ${scatterDataJson};
                const host = document.getElementById("stopsMilesScatterHost");
                const tooltip = document.getElementById("scatterTooltip");
                const chartToast = document.getElementById("chartToast");
                const dayFilter = document.getElementById("scatterDayFilter");
                const overOnly = document.getElementById("scatterOverOnly");
                const targetHours = ${targetHours};
                const sectionRows = Array.from(document.querySelectorAll(".section-route-row"));
                const modal = document.getElementById("sectionRouteDayModal");
                const modalTitle = document.getElementById("sectionRouteDayTitle");
                const modalList = document.getElementById("sectionRouteDayList");
                const modalClose = document.getElementById("sectionRouteDayClose");

                function escapeHtmlLocal(value) {
                  return String(value ?? "")
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/\"/g, "&quot;")
                    .replace(/'/g, "&#39;");
                }

                function openRouteDayModal(title, rows) {
                  modalTitle.textContent = title;
                  if (!rows.length) {
                    modalList.innerHTML = "<li>No route+day entries found.</li>";
                  } else {
                    const sorted = rows.slice().sort((a, b) => String(a.routeDay || "").localeCompare(String(b.routeDay || "")));
                    modalList.innerHTML = sorted.map(r =>
                      "<li><strong>" + escapeHtmlLocal(r.routeDay) + "</strong> - Stops: " + Number(r.stops || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
                      ", Miles: " + Number(r.miles || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
                      ", Time: " + Number(r.totalTime || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "h</li>"
                    ).join("");
                  }
                  modal.classList.remove("hidden");
                }

                function closeRouteDayModal() {
                  modal.classList.add("hidden");
                }

                function showChartToast(message, isError) {
                  if (!chartToast) return;
                  chartToast.textContent = message;
                  chartToast.classList.toggle("error", !!isError);
                  chartToast.classList.add("show");
                  setTimeout(() => {
                    chartToast.classList.remove("show");
                  }, 1900);
                }

                modalClose.addEventListener("click", closeRouteDayModal);
                modal.addEventListener("click", e => {
                  if (e.target === modal) closeRouteDayModal();
                });

                sectionRows.forEach(row => {
                  row.addEventListener("click", () => {
                    const kind = row.getAttribute("data-kind") || "";
                    const rawKey = row.getAttribute("data-key") || "";
                    const key = decodeURIComponent(rawKey);

                    if (kind === "day") {
                      const matched = data.filter(d => String(d.day || "") === key);
                      openRouteDayModal("Route+Day entries for " + key, matched);
                      return;
                    }

                    if (kind === "target") {
                      const isOverBucket = key.toLowerCase().startsWith("over ");
                      const matched = data.filter(d => isOverBucket ? Number(d.totalTime) > targetHours : Number(d.totalTime) <= targetHours);
                      openRouteDayModal("Route+Day entries: " + key, matched);
                    }
                  });
                });

                const days = Array.from(new Set(data.map(d => String(d.day || "").trim()).filter(Boolean))).sort();
                days.forEach(day => {
                  const opt = document.createElement("option");
                  opt.value = day;
                  opt.textContent = day;
                  dayFilter.appendChild(opt);
                });

                function render() {
                  const selectedDay = dayFilter.value;
                  const filtered = data.filter(d => {
                    if (selectedDay !== "all" && String(d.day) !== selectedDay) return false;
                    if (overOnly.checked && !(d.totalTime > targetHours)) return false;
                    return true;
                  });

                  if (!filtered.length) {
                    host.innerHTML = '<div class="empty">No points match the selected filters.</div>';
                    return;
                  }

                  const width = 980;
                  const height = 360;
                  const padL = 56;
                  const padR = 24;
                  const padT = 20;
                  const padB = 46;
                  const plotW = width - padL - padR;
                  const plotH = height - padT - padB;
                  const maxX = Math.max(1, ...filtered.map(p => p.stops));
                  const maxY = Math.max(1, ...filtered.map(p => p.miles));
                  const x = v => padL + (v / maxX) * plotW;
                  const y = v => padT + plotH - (v / maxY) * plotH;

                  const xTicks = Array.from({ length: 6 }, (_, i) => {
                    const val = (maxX * i) / 5;
                    const px = x(val);
                    return '<line x1="' + px + '" y1="' + padT + '" x2="' + px + '" y2="' + (padT + plotH) + '" stroke="#e6edf6" stroke-width="1" />' +
                      '<text x="' + px + '" y="' + (padT + plotH + 18) + '" text-anchor="middle" fill="#627d97" font-size="11">' + val.toFixed(0) + '</text>';
                  }).join("");

                  const yTicks = Array.from({ length: 6 }, (_, i) => {
                    const val = (maxY * i) / 5;
                    const py = y(val);
                    return '<line x1="' + padL + '" y1="' + py + '" x2="' + (padL + plotW) + '" y2="' + py + '" stroke="#e6edf6" stroke-width="1" />' +
                      '<text x="' + (padL - 8) + '" y="' + (py + 4) + '" text-anchor="end" fill="#627d97" font-size="11">' + val.toFixed(0) + '</text>';
                  }).join("");

                  const circles = filtered.map((p, idx) => {
                    const color = p.totalTime > targetHours ? "#e25b53" : "#2f89df";
                    const info = (String(p.routeDay || "") + " | Stops: " + p.stops.toFixed(2) + " | Miles: " + p.miles.toFixed(2) + " | Total Time: " + p.totalTime.toFixed(2) + "h")
                      .replace(/&/g, "&amp;")
                      .replace(/</g, "&lt;")
                      .replace(/>/g, "&gt;");
                    const routeSafe = String(p.route || "").replace(/"/g, "&quot;");
                    const daySafe = String(p.day || "").replace(/"/g, "&quot;");
                    return '<circle class="scatter-point" data-route="' + routeSafe + '" data-day="' + daySafe + '" data-info="' + info + '" cx="' + x(p.stops) + '" cy="' + y(p.miles) + '" r="5" fill="' + color + '" fill-opacity="0.85" stroke="#ffffff" stroke-width="1.2" />';
                  }).join("");

                  host.innerHTML =
                    '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Stops vs miles scatter plot by route and day">' +
                    xTicks + yTicks +
                    '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="#8ea4bb" stroke-width="1.2" />' +
                    '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#8ea4bb" stroke-width="1.2" />' +
                    circles +
                    '<text x="' + (padL + plotW / 2) + '" y="' + (height - 8) + '" text-anchor="middle" fill="#3e5f7d" font-size="12">Total Stops</text>' +
                    '<text x="16" y="' + (padT + plotH / 2) + '" text-anchor="middle" fill="#3e5f7d" font-size="12" transform="rotate(-90 16 ' + (padT + plotH / 2) + ')">Miles</text>' +
                    '</svg>';

                  host.querySelectorAll(".scatter-point").forEach(el => {
                    el.addEventListener("mousemove", e => {
                      tooltip.style.display = "block";
                      tooltip.style.left = (e.clientX + 12) + "px";
                      tooltip.style.top = (e.clientY + 12) + "px";
                      tooltip.innerHTML = el.getAttribute("data-info") || "";
                    });
                    el.addEventListener("mouseleave", () => {
                      tooltip.style.display = "none";
                    });
                    el.addEventListener("click", () => {
                      const route = el.getAttribute("data-route") || "";
                      const day = el.getAttribute("data-day") || "";

                      if (!window.opener || typeof window.opener.highlightRouteDayOnMap !== "function") {
                        showChartToast("Could not connect to map window.", true);
                        return;
                      }

                      let result = null;
                      try {
                        result = window.opener.highlightRouteDayOnMap(route, day);
                      } catch (err) {
                        showChartToast("Failed to highlight on map.", true);
                        return;
                      }

                      if (result && result.ok) {
                        showChartToast("Route+Day highlighted on map.", false);
                      } else {
                        showChartToast((result && result.message) ? result.message : "No matching Route+Day found.", true);
                      }
                    });
                  });
                }

                dayFilter.addEventListener("change", render);
                overOnly.addEventListener("change", render);
                render();
              })();
            </script>
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
    individuallySelectedMarkers.clear();
    individuallyDeselectedMarkers.clear();
    highlightedMarkers.clear();

    // 3. Remove ALL markers from map
    Object.values(routeDayGroups).forEach(group => {
      group.layers.forEach(marker => map.removeLayer(marker));
    });

    // 4. Clear stored marker groups & symbols
    Object.keys(routeDayGroups).forEach(k => delete routeDayGroups[k]);
    Object.keys(symbolMap).forEach(k => delete symbolMap[k]);
    updateSelectionCount();

    // 5. Reset counters & stats
    if (!deliverySaveInProgress) setDeliverySaveStatus("idle", "");
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

// ================= FILE MANAGER MODAL =================
const fileManagerModal = document.getElementById("fileManagerModal");
const openFileManagerBtn = document.getElementById("openFileManagerBtn");
const closeFileManagerBtn = document.getElementById("closeFileManager");
const savedFilesGuide = document.getElementById("savedFilesGuide");

function markSavedFilesGuideSeen() {
  localStorage.setItem("savedFilesGuideSeen", "1");
}

if (openFileManagerBtn) {
  if (savedFilesGuide) savedFilesGuide.classList.remove("hidden");

  openFileManagerBtn.classList.add("attention");

  openFileManagerBtn.addEventListener("click", () => {
    fileManagerModal.style.display = "flex";
    markSavedFilesGuideSeen();
    setSavedFilesTab("cartDelivery");
  });
}

if (closeFileManagerBtn) {
  closeFileManagerBtn.addEventListener("click", () => {
    fileManagerModal.style.display = "none";
  });
}

window.addEventListener("click", (e) => {
  if (e.target === fileManagerModal) {
    fileManagerModal.style.display = "none";
  }
});
  

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

    const baseName = getDownloadBaseName(window._currentFilePath);

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
// ---- STREET LABEL LOGIC (HARD TOGGLE CONTROL) ----
if (layer._hasStreetLabel) {

  // 🚫 If toggle is OFF, force close and skip
  if (!window.streetLabelsEnabled) {
    layer.closeTooltip();
    return;
  }

  const bounds = map.getBounds();
  const isVisible = bounds.contains(layer.getLatLng());

  const MAX_LABELS = 150;
  if (!window._labelCount) window._labelCount = 0;

  if (
    currentZoom >= maxZoom - 3 &&
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
const streetToggle = document.getElementById("streetLabelToggle");

if (streetToggle) {

  // Set initial state based on checkbox
  window.streetLabelsEnabled = streetToggle.checked;

  // Force labels to respect initial state
  map.whenReady(() => {
    map.fire("zoomend");
  });

  streetToggle.addEventListener("change", (e) => {
    window.streetLabelsEnabled = e.target.checked;

    // Immediately refresh labels
    map.fire("zoomend");
  });
}
  
////////////////////////////////////////////////////////////////////
// 🔍 MAP ADDRESS SEARCH (PASTE RIGHT BELOW STREET TOGGLE)
////////////////////////////////////////////////////////////////////

const searchInput = document.getElementById("mapSearchInput");
const searchBtn   = document.getElementById("mapSearchBtn");

function searchMapByAddress() {

  if (!searchInput) return;

  const query = searchInput.value.trim().toLowerCase();
  if (!query) return;

  const resultsPanel = document.getElementById("searchResultsPanel");
  const resultsList  = document.getElementById("searchResultsList");

  resultsList.innerHTML = "";
  let matches = [];

  Object.values(routeDayGroups).forEach(group => {

    group.layers.forEach(marker => {

      const row = marker._rowRef;
      if (!row) return;

      const address = [
        row["CSADR#"] || "",
        row["CSSDIR"] || "",
        row["CSSTRT"] || "",
        row["CSSFUX"] || ""
      ].join(" ").toLowerCase();

      if (address.includes(query)) {
        matches.push({ marker, row });
      }

    });

  });

  if (!matches.length) {
    alert("No matching addresses found.");
    return;
  }

  matches.forEach((item, index) => {

    const div = document.createElement("div");
    div.className = "search-result-item";

    const displayAddress = [
      item.row["CSADR#"] || "",
      item.row["CSSDIR"] || "",
      item.row["CSSTRT"] || "",
      item.row["CSSFUX"] || ""
    ].join(" ");

    div.textContent = displayAddress;

    div.onclick = () => {

      // Remove previous selected styling
      document.querySelectorAll(".search-result-item")
        .forEach(el => el.classList.remove("selected"));

      div.classList.add("selected");

      map.setView(item.marker.getLatLng(), 18);

      item.marker.setStyle?.({
        color: "#ffff00",
        fillColor: "#ffff00",
        fillOpacity: 1
      });

    };

    resultsList.appendChild(div);

  });

  resultsPanel.classList.remove("hidden");
}
  // Hook up search button + Enter key
if (searchBtn) {
  searchBtn.addEventListener("click", searchMapByAddress);
}

if (searchInput) {
  searchInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      searchMapByAddress();
    }
  });
}
  // ===== CLEAR SEARCH RESULTS =====
const clearSearchBtn = document.getElementById("clearSearchResults");

if (clearSearchBtn) {
  clearSearchBtn.addEventListener("click", () => {

    // Clear search input
    const searchInput = document.getElementById("mapSearchInput");
    if (searchInput) searchInput.value = "";

    // Clear results list
    const resultsList = document.getElementById("searchResultsList");
    if (resultsList) resultsList.innerHTML = "";

    // Hide results panel
    const resultsPanel = document.getElementById("searchResultsPanel");
    if (resultsPanel) {
      resultsPanel.classList.add("hidden");
    }

  });
}
// Build a separate workbook so failed saves leave the current route unchanged.
async function saveWorkbookToCloud(rows, workbook, filePath) {
  const nextWorkbook = {
    ...workbook,
    Sheets: {
      ...workbook.Sheets,
      [workbook.SheetNames[0]]: XLSX.utils.json_to_sheet(rows)
    }
  };
  const wbArray = XLSX.write(nextWorkbook, {
    bookType: filePath.toLowerCase().endsWith(".xlsm") ? "xlsm" : "xlsx",
    type: "array"
  });
  const { error } = await sb.storage.from(BUCKET).upload(filePath, wbArray, {
    upsert: true,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  if (error) throw error;
  return nextWorkbook;
}

async function saveSelectedDeliveryStatus(markDelivered) {
  if (deliverySaveInProgress) return;
  const rows = window._currentRows;
  const workbook = window._currentWorkbook;
  const filePath = window._currentFilePath;
  if (!rows || !workbook || !filePath) {
    setDeliverySaveStatus("error", "Not saved — load a route file first.");
    return;
  }

  const selectionTester = createSelectionTester();
  const selected = [];
  Object.entries(routeDayGroups).forEach(([key, group]) => {
    group.layers.forEach(marker => {
      const row = marker._rowRef;
      const delivered = String(row?.del_status || "").trim().toLowerCase() === "delivered";
      if (row && delivered !== markDelivered && isStopSelected(marker, selectionTester)) {
        selected.push({ key, marker, row });
      }
    });
  });
  if (!selected.length) {
    setDeliverySaveStatus("error", markDelivered
      ? "Select undelivered stops first."
      : "Select delivered stops to undo.");
    return;
  }
  if (!markDelivered && !confirm("Are you sure you want to undo the selected Delivered stops?")) return;

  const count = selected.length;
  const stopLabel = count === 1 ? "stop" : "stops";
  const nextStatus = markDelivered ? "Delivered" : "";
  const selectedRows = new Set(selected.map(item => item.row));
  const nextRows = rows.map(row => selectedRows.has(row) ? { ...row, del_status: nextStatus } : row);
  setDeliverySaveStatus("saving", `Saving… ${count} ${stopLabel}`);

  let savedWorkbook;
  try {
    savedWorkbook = await saveWorkbookToCloud(nextRows, workbook, filePath);
  } catch (error) {
    console.error("Cloud Save Error:", error);
    setDeliverySaveStatus("error", "Not saved — check your connection and try again.");
    return;
  }

  // A route opened during the upload must keep its own markers and workbook.
  const routeIsCurrent = window._currentRows === rows &&
    window._currentWorkbook === workbook && window._currentFilePath === filePath;
  if (routeIsCurrent) {
    window._currentWorkbook = savedWorkbook;
    selected.forEach(({ key, marker, row }) => {
      row.del_status = nextStatus;
      const group = routeDayGroups[key];
      if (!group?.layers.includes(marker)) return;
      group.layers = group.layers.filter(layer => layer !== marker);
      const nextKey = `${row.NEWROUTE}|${markDelivered ? "Delivered" : row.NEWDAY}`;
      if (!routeDayGroups[nextKey]) routeDayGroups[nextKey] = { layers: [] };
      getSymbol(nextKey);
      routeDayGroups[nextKey].layers.push(marker);
      restoreMarkerStyle(marker, nextKey);
    });

    document.querySelectorAll("#routeDayLayers input[type='checkbox'], #deliveredControls input[type='checkbox']")
      .forEach(checkbox => {
        if (checkbox.dataset.key) layerVisibilityState[checkbox.dataset.key] = checkbox.checked;
      });
    drawnLayer.clearLayers();
    individuallySelectedMarkers.clear();
    individuallyDeselectedMarkers.clear();
    buildRouteDayLayerControls();
    updateSelectionCount();
    updateUndoButtonState();
  }

  const action = markDelivered ? "marked delivered" : "restored";
  const fileNote = routeIsCurrent ? "" : ` in ${filePath}`;
  setDeliverySaveStatus("saved", `Saved — ${count} ${stopLabel} ${action}${fileNote}.`);
}

function completeStops() {
  return saveSelectedDeliveryStatus(true);
}

function undoDelivered() {
  return saveSelectedDeliveryStatus(false);
}
 // ================= LOADING OVERLAY =================
window.showLoading = function(message) {
  const loader = document.getElementById("loadingOverlay");
  if (!loader) return;

  loader.classList.remove("hidden");

  const text = loader.querySelector(".loading-text");
  if (text) {
    text.textContent = message || "Loading...";
  }
};

window.hideLoading = function(message) {
  const loader = document.getElementById("loadingOverlay");
  if (!loader) return;

  const text = loader.querySelector(".loading-text");

  if (message && text) {
    text.textContent = message;
    setTimeout(() => {
      loader.classList.add("hidden");
    }, 900);
  } else {
    loader.classList.add("hidden");
  }
};
//////
  
// ===== ROUTE + DAY COLLAPSIBLE =====
const routeDayToggle = document.getElementById("routeDayToggle");
const routeDayContent = document.getElementById("routeDayContent");

if (routeDayToggle && routeDayContent) {

  // Closed by default
  routeDayContent.classList.add("collapsed");

  routeDayToggle.addEventListener("click", (e) => {

    // Prevent clicking All/None from toggling collapse
    if (e.target.id === "routeDayAll" || e.target.id === "routeDayNone") return;

    const isCollapsed = routeDayContent.classList.toggle("collapsed");

    routeDayToggle.classList.toggle("open", !isCollapsed);
  });
}

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

// ===== STATS COLLAPSIBLE =====
const statsToggle = document.getElementById("statsToggle");
const statsContent = document.getElementById("statsContent");

if (statsToggle && statsContent) {

  // Closed by default
  statsContent.classList.add("collapsed");

  statsToggle.addEventListener("click", () => {
    const isCollapsed = statsContent.classList.toggle("collapsed");
    statsToggle.classList.toggle("open", !isCollapsed);
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
