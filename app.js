/*
 * Cart Delivery app - single-file client logic (no build step, no modules).
 * See README.md for the architecture guide and AGENTS.md for editing rules.
 *
 * Map of this file (search for the "=====" section banners):
 *   1. Delivery button/status helpers (top of file)
 *   2. Supabase config + global state (window._currentRows / _currentWorkbook / _currentFilePath)
 *   3. Header tools menu, Sun Mode, GPS locate / live tracking / Copy Location
 *   4. Leaflet map setup, base layers, Leaflet.Draw polygon selection
 *   5. Selection engine: createSelectionTester, isStopSelected, toggleIndividualStopSelection,
 *      nearby-stop chooser (phone tap selection), updateSelectionCount
 *   6. Marker creation, route/day filters, statistics
 *   7. Sequence arrows: rowSequence, rebuildSequenceData, renderSequenceLayer
 *   8. processExcelBuffer: turns a workbook into markers and sequence groups (core data flow)
 *   9. Shared truck / trailer load log and Excel export
 *  10. Saved files (Supabase storage list/upload, shared Cart Delivery tab)
 *  11. placeDeliveryControls + initApp: layout wiring, mobile menu, selection mode, reset, search
 *  12. Cloud save of delivery status (saveSelectedDeliveryStatus), collapsibles, button events
 *
 * Key invariants:
 *   - Every marker has marker._rowRef (the spreadsheet row object) and marker._base ({lat, lon, symbol}).
 *   - routeDayGroups["ROUTE|DAY"] or ["ROUTE|Delivered"] = { layers: [markers] } is the source of truth for markers.
 *   - Only visible markers can be selected: individuallySelectedMarkers, or inside the drawn polygon and
 *     not in individuallyDeselectedMarkers. Always use isStopSelected(); never read marker styles to decide.
 *   - sequenceGroups keeps original route/day order and row references, including hidden delivered stops.
 *     Delivery badges and segment colors read those rows only after a confirmed save/undo.
 *   - del_status === "Delivered" (case-insensitive) in a row means delivered. Saving rewrites the whole sheet.
 *   - updateSelectionCount is re-assigned later (mobile selection section) to also refresh the phone button;
 *     call it by name after any selection change, plus updateUndoButtonState().
 *   - Layout is "mobile" at window.innerWidth <= 900; placeDeliveryControls moves the same DOM nodes between
 *     the phone dock (#deliveryControls) and the desktop sidebar, so do not duplicate buttons.
 */
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
// NOTE: client-side only; anyone can read it in the source. Not real security.
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
window.addEventListener("load", placeDeliveryControls);

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


// Copy a fresh GPS fix without changing map selections or live-tracking state.
function setupLocationCopy() {
  const dialog = document.getElementById("copyLocationDialog");
  const status = document.getElementById("copyLocationStatus");
  const coordinates = document.getElementById("currentCoordinates");
  const accuracy = document.getElementById("currentLocationAccuracy");
  const addressSelect = document.getElementById("nearbyLocationAddress");
  const addressHelp = document.getElementById("nearbyLocationHelp");
  const copyCoordinatesBtn = document.getElementById("copyCoordinatesBtn");
  const copyMapLinkBtn = document.getElementById("copyMapLinkBtn");
  const copyAddressBtn = document.getElementById("copyNearbyAddressBtn");
  const updateBtn = document.getElementById("updateCopyLocationBtn");
  const manualCopy = document.getElementById("manualLocationCopy");
  const manualText = document.getElementById("manualLocationText");
  const maxAge = 60000;
  let position = null;
  let requestId = 0;
  let expiryTimer = null;

  function showStatus(message, state = "ready") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function disableCopy() {
    copyCoordinatesBtn.disabled = true;
    copyMapLinkBtn.disabled = true;
    copyAddressBtn.disabled = true;
    addressSelect.disabled = true;
  }

  function isFresh() {
    if (!position) return false;
    if (Date.now() - position.timestamp < maxAge) return true;
    disableCopy();
    showStatus("This location is over a minute old. Tap Update Location before copying.", "error");
    return false;
  }

  function populateNearbyAddresses() {
    addressSelect.replaceChildren(new Option("Choose the address you are at", ""));
    const candidates = new Map();
    // A poor GPS fix cannot reliably identify which nearby address the crew is at.
    if (position.coords.accuracy <= 75) {
      const here = L.latLng(position.coords.latitude, position.coords.longitude);
      (window._currentRows || []).forEach(row => {
        const lat = Number(row.LATITUDE);
        const lng = Number(row.LONGITUDE);
        if (!row.CSSTRT || row.LATITUDE == null || row.LONGITUDE == null ||
            String(row.LATITUDE).trim() === "" || String(row.LONGITUDE).trim() === "" ||
            !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        const distance = here.distanceTo([lat, lng]);
        if (distance > 75) return;
        const locality = [row.CITY || row.CSCITY, row.STATE || row.CSSTATE, row.ZIP || row.CSZIP]
          .filter(value => value != null && String(value).trim()).join(" ");
        const address = [formatStopAddress(row), locality].filter(Boolean).join(", ");
        if (!candidates.has(address) || distance < candidates.get(address)) candidates.set(address, distance);
      });
    }
    [...candidates].sort((a, b) => a[1] - b[1]).forEach(([address, distance]) => {
      addressSelect.add(new Option(`${address} · ${Math.round(distance * 3.28084)} ft away`, address));
    });
    addressSelect.disabled = candidates.size === 0;
    addressHelp.textContent = candidates.size
      ? "Choose your address from the loaded route. These addresses are within about 250 ft of your GPS position."
      : position.coords.accuracy > 75
        ? "GPS is too approximate to suggest an address. Update Location for a closer fix, or copy coordinates."
        : "No nearby address in the loaded route. Copy coordinates or the map link instead.";
  }

  function requestLocation() {
    const id = ++requestId;
    clearTimeout(expiryTimer);
    position = null;
    coordinates.value = "";
    coordinates.placeholder = "Getting your location…";
    accuracy.textContent = "";
    manualCopy.hidden = true;
    addressSelect.replaceChildren(new Option("Waiting for your location", ""));
    addressHelp.textContent = "Choose the address you are at from the loaded route.";
    disableCopy();

    if (!navigator.geolocation) {
      coordinates.placeholder = "Location unavailable";
      showStatus("Location is unavailable in this browser. Open the app in Safari or Chrome.", "error");
      return;
    }

    updateBtn.disabled = true;
    showStatus("Getting your current GPS location…", "loading");
    navigator.geolocation.getCurrentPosition(result => {
      if (id !== requestId || !dialog.open) return;
      updateBtn.disabled = false;
      const { latitude, longitude, accuracy: meters } = result.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
          !Number.isFinite(meters) || meters < 0) {
        showStatus("A usable GPS location was not returned. Tap Update Location to retry.", "error");
        return;
      }
      position = result;
      coordinates.value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      const time = new Date(result.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      accuracy.textContent = `Located at ${time} · GPS accuracy ±${Math.ceil(meters * 3.28084)} ft. Update if you move.`;
      copyCoordinatesBtn.disabled = false;
      copyMapLinkBtn.disabled = false;
      populateNearbyAddresses();
      showStatus(meters > 75
        ? "GPS is approximate. Check the accuracy below before sending."
        : "Ready to copy. Paste it into a message to the incoming truck.");
      if (isFresh()) expiryTimer = setTimeout(isFresh, Math.max(0, maxAge - (Date.now() - result.timestamp)));
    }, error => {
      if (id !== requestId || !dialog.open) return;
      updateBtn.disabled = false;
      coordinates.placeholder = "Location unavailable";
      const message = error.code === 1
        ? "Location permission is off. Allow location access for this site, then tap Update Location."
        : error.code === 3
          ? "GPS took too long. Move to a clearer area and tap Update Location."
          : "Your location could not be found. Tap Update Location to retry.";
      showStatus(message, "error");
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  // GPS finishes before this click, preserving Safari's clipboard user gesture.
  async function copyText(text, description) {
    if (!isFresh() || !text) return;
    const id = requestId;
    manualCopy.hidden = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (id === requestId && dialog.open) showStatus(`${description} copied. Paste it into your message.`, "copied");
    } catch {
      if (id !== requestId || !dialog.open) return;
      manualCopy.hidden = false;
      manualText.value = text;
      manualText.focus();
      manualText.select();
      showStatus("Automatic copy is unavailable. Press and hold the selected text below to copy.", "error");
    }
  }

  document.getElementById("copyLocationBtn").addEventListener("click", () => {
    dialog.showModal();
    requestLocation();
  });
  document.getElementById("closeCopyLocationBtn").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    ++requestId;
    clearTimeout(expiryTimer);
    position = null;
    updateBtn.disabled = false;
  });
  updateBtn.addEventListener("click", requestLocation);
  coordinates.addEventListener("click", () => coordinates.select());
  addressSelect.addEventListener("change", () => {
    copyAddressBtn.disabled = !isFresh() || !addressSelect.value;
  });
  copyCoordinatesBtn.addEventListener("click", () => copyText(coordinates.value, "Coordinates"));
  copyMapLinkBtn.addEventListener("click", () => {
    const url = new URL("https://www.google.com/maps/search/");
    url.searchParams.set("api", "1");
    url.searchParams.set("query", coordinates.value);
    copyText(url.toString(), "Map link");
  });
  copyAddressBtn.addEventListener("click", () => copyText(addressSelect.value, "Address"));
  document.addEventListener("visibilitychange", () => {
    if (dialog.open && !document.hidden) isFresh();
  });
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


// Backup download names are "<Base>_Backup_YYYY-MM-DD_HHMM.xlsx" (short, sorts by date, newest last).
// The base name is cleaned first so re-uploading and re-downloading never grows the name:
// strips any earlier _Backup_/_Downloaded_ stamps (new or old format, repeated) and browser
// duplicate suffixes like " (1)", and caps the length.
function getDownloadBaseName(filePath) {
  let name = (filePath || "Export").replace(/\.[^/.]+$/, "");
  const stamp = /(?:[_ -]*\(\d+\))?(?:_(?:Backup|Downloaded)_\d{4}-\d{2}-\d{2}_\d{2}-?\d{2}(?:-\d{2})?)+(?:[_ -]*\(\d+\))?$/i;
  let previous;
  do {
    previous = name;
    name = name.replace(stamp, "").replace(/[_ -]*\(\d+\)$/, "");
  } while (name !== previous);
  return name.slice(0, 60) || "Export";
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

// Leaflet.Draw 1.0.4 adds a polygon vertex the instant a finger touches the map (touchstart),
// so panning/pinching while drawing dropped unwanted points. Override: a vertex is added on
// touchend only if it was a quick, single-finger tap that did not move (<10px).
L.Draw.Polyline.prototype._onTouch = function (e) {
  const original = e.originalEvent;
  if (!original || !original.touches || !original.touches[0]) { this._clickHandled = null; return; }
  if (this._clickHandled || this._touchHandled || this._disableMarkers) return;
  this._clickHandled = null;
  const container = this._map.getContainer();
  const start = { x: original.touches[0].clientX, y: original.touches[0].clientY, time: Date.now() };
  let cancelled = original.touches.length > 1;
  const cleanup = () => {
    container.removeEventListener("touchmove", onMove);
    container.removeEventListener("touchend", onEnd);
    container.removeEventListener("touchcancel", onCancel);
  };
  const onMove = ev => {
    const t = ev.touches[0];
    if (ev.touches.length > 1 || (t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10)) cancelled = true;
  };
  const onCancel = () => cleanup();
  const onEnd = ev => {
    cleanup();
    const t = ev.changedTouches && ev.changedTouches[0];
    if (cancelled || !t || ev.touches.length || Date.now() - start.time > 600) return;
    const latlng = this._map.mouseEventToLatLng(t);
    this._disableNewMarkers();
    this._touchHandled = true;
    this._startPoint(start.x, start.y);
    this._endPoint(t.clientX, t.clientY, { latlng, originalEvent: ev });
    this._touchHandled = null;
  };
  container.addEventListener("touchmove", onMove, { passive: true });
  container.addEventListener("touchend", onEnd, { passive: true });
  container.addEventListener("touchcancel", onCancel, { passive: true });
};
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

// ===== EASIER SHAPE CLOSING (PHONE) =====
// Leaflet.Draw only closes a shape by tapping the first point, which is hard to find. While a
// polygon is being drawn we (1) mark the first point green and enlarge it, (2) show a large
// "Finish Shape" button (calls handler.completeShape()), (3) show a "Cancel" button.
let activeDrawHandler = null;
const drawActionBar = document.createElement("div");
drawActionBar.id = "drawActionBar";
drawActionBar.hidden = true;
drawActionBar.innerHTML =
  '<button type="button" id="drawFinishBtn">Finish Shape</button>' +
  '<button type="button" id="drawCancelBtn">Cancel</button>';
map.getContainer().appendChild(drawActionBar);
L.DomEvent.disableClickPropagation(drawActionBar);

function hideDrawActionBar() {
  activeDrawHandler = null;
  drawActionBar.hidden = true;
}
map.on(L.Draw.Event.DRAWSTART, e => {
  if (e.layerType !== "polygon") return;
  activeDrawHandler = drawControl._toolbars.draw._modes.polygon.handler;
  drawActionBar.hidden = true;
});
map.on(L.Draw.Event.DRAWVERTEX, e => {
  const layers = e.layers && e.layers.getLayers();
  if (layers && layers[0] && layers[0]._icon) layers[0]._icon.classList.add("first-draw-vertex");
  // A polygon needs 3 points before it can be finished.
  drawActionBar.hidden = !activeDrawHandler || !layers || layers.length < 3;
});
map.on(L.Draw.Event.DRAWSTOP, hideDrawActionBar);
map.on(L.Draw.Event.CREATED, hideDrawActionBar);
document.getElementById("drawFinishBtn").addEventListener("click", () => {
  if (activeDrawHandler) activeDrawHandler.completeShape();
});
document.getElementById("drawCancelBtn").addEventListener("click", () => {
  if (activeDrawHandler) activeDrawHandler.disable();
});

L.drawLocal.draw.handlers.polygon.tooltip.end = 'Tap the green first point or Finish Shape to close';

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

// Returns a function(latlng) => boolean that tests the drawn polygon/rectangle geometry
// (holes supported) in projected pixel space. Returns () => false when nothing is drawn.
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

// Single source of truth for "is this stop selected?". Pass a shared tester when looping
// over many markers so the polygon is only projected once.
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

// Toggles one stop. Adds to individuallySelectedMarkers; if the stop is inside the drawn area,
// deselecting records it in individuallyDeselectedMarkers instead.
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

// Phone tap selection: returns visible markers within the tap radius, nearest first.
// Radius is max(32px, marker radius + 20px) in map container pixels.
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
      : (dayName(Number(rowDay(row))) || `Day ${rowDay(row) || key.split("|")[1]}`);
    const bin = row.BINNO ? ` · Bin ${row.BINNO}` : "";
    const sequence = rowSequence(row);
    detail.textContent = `Route ${rowRoute(row) || key.split("|")[0]} · ${status}${bin}${sequence !== null ? ` · Seq ${sequence}` : ""} · ${Math.round(distance)} px away`;

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

// Selects the nearest stop directly, or opens the chooser (#mobileStopPicker) when the two
// nearest candidates are within 12px of each other. Tune this threshold here.
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

function getLayerLatLng(layer) {
  if (!layer) return null;
  if (typeof layer.getLatLng === "function") return layer.getLatLng();
  if (typeof layer.getBounds === "function") return layer.getBounds().getCenter();
  if (layer._base && Number.isFinite(layer._base.lat) && Number.isFinite(layer._base.lon)) {
    return L.latLng(layer._base.lat, layer._base.lon);
  }
  return null;
}

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


// Route/day come from the ROUTE and DAY columns only (NEWROUTE/NEWDAY are ignored).
function rowRoute(row) { return row.ROUTE; }
function rowDay(row) { return row.DAY; }

// Zero is a valid sequence; blank or invalid values must not become zero.
function rowSequence(row) {
  const value = row.SEQNO;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// ================= SEQUENCE ARROWS =================
// Original route/day groups are independent of marker filters and delivered-marker groups.
const sequenceGroups = new Map();
const sequencePane = map.createPane("sequencePane");
sequencePane.style.zIndex = "350";
sequencePane.style.pointerEvents = "none";
const sequenceRenderer = L.canvas({ pane: "sequencePane", padding: 0.2 });
const sequenceLayer = L.layerGroup();
const sequenceStyle = { renderer: sequenceRenderer, pane: "sequencePane", interactive: false, smoothFactor: 0, lineCap: "round" };
const sequenceHalo = L.polyline([], { ...sequenceStyle, color: "#ffffff", weight: 4, opacity: 0.8 }).addTo(sequenceLayer);
const sequenceCompletedLine = L.polyline([], { ...sequenceStyle, color: "#64748b", weight: 1.7, opacity: 0.8, dashArray: "5 5" }).addTo(sequenceLayer);
const sequencePendingLine = L.polyline([], { ...sequenceStyle, color: "#173dff", weight: 1.7, opacity: 1 }).addTo(sequenceLayer);
const sequenceCompletedArrows = L.polygon([], { ...sequenceStyle, color: "#64748b", weight: 0, fillOpacity: 0.85 }).addTo(sequenceLayer);
const sequencePendingArrows = L.polygon([], { ...sequenceStyle, color: "#173dff", weight: 0, fillOpacity: 1 }).addTo(sequenceLayer);
const sequenceDeliveredBadges = L.polygon([], { ...sequenceStyle, color: "#ffffff", fillColor: "#137442", weight: 1.5, fillOpacity: 1 }).addTo(sequenceLayer);
const sequenceDeliveredChecks = L.polyline([], { ...sequenceStyle, color: "#ffffff", weight: 1.8, opacity: 1 }).addTo(sequenceLayer);
let sequenceFrame = null;
let sequenceDataNote = "";

function scheduleSequenceRender() {
  if (sequenceFrame !== null) return;
  sequenceFrame = requestAnimationFrame(() => { sequenceFrame = null; renderSequenceLayer(); });
}

// Rebuild on file load/reset; retain row references so confirmed saves need only a redraw.
function rebuildSequenceData(rows) {
  sequenceGroups.clear();
  let missing = 0;
  let invalidCoordinates = 0;
  let duplicates = 0;
  rows.forEach((row, index) => {
    const seq = rowSequence(row);
    const route = String(rowRoute(row) ?? "").trim();
    const day = String(rowDay(row) ?? "").trim();
    const dayNumber = Number(day);
    if (seq === null || !route || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 7) { missing++; return; }
    const lat = Number(row.LATITUDE), lng = Number(row.LONGITUDE);
    const located = String(row.LATITUDE ?? "").trim() !== "" && String(row.LONGITUDE ?? "").trim() !== "" &&
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (!located) invalidCoordinates++;
    const key = JSON.stringify([route, day]);
    if (!sequenceGroups.has(key)) sequenceGroups.set(key, { route, day, stops: [] });
    // Keep an unlocated stop in order to break the path instead of skipping across it.
    sequenceGroups.get(key).stops.push({ row, seq, index, latlng: located ? L.latLng(lat, lng) : null });
  });
  sequenceGroups.forEach(group => {
    group.stops.sort((a, b) => a.seq - b.seq || a.index - b.index);
    group.stops.forEach((stop, i) => { if (i && stop.seq === group.stops[i - 1].seq) duplicates++; });
  });
  const select = document.getElementById("sequenceRouteSelect");
  select.replaceChildren(new Option("All route / day sequences", "all"));
  sequenceGroups.forEach((group, key) => select.add(new Option(`Route ${group.route} · ${dayName(Number(group.day)) || `Day ${group.day}`}`, key)));
  const usable = [...sequenceGroups.values()].some(group => group.stops.some((stop, i) =>
    i && stop.latlng && group.stops[i - 1].latlng && !stop.latlng.equals(group.stops[i - 1].latlng)));
  const toggle = document.getElementById("sequenceLayerToggle");
  toggle.disabled = !usable;
  if (!usable) toggle.checked = false;
  sequenceDataNote = [missing ? `${missing} rows without a valid sequence/route/day omitted.` : "",
    invalidCoordinates ? `${invalidCoordinates} invalid locations break the path.` : "",
    duplicates ? "Duplicate sequence values follow spreadsheet row order." : ""].filter(Boolean).join(" ");
  scheduleSequenceRender();
}

function renderSequenceLayer() {
  const toggle = document.getElementById("sequenceLayerToggle");
  const status = document.getElementById("sequenceLayerStatus");
  document.getElementById("sequenceLayerOptions").hidden = !toggle.checked;
  if (!toggle.checked || toggle.disabled) {
    map.removeLayer(sequenceLayer);
    status.textContent = toggle.disabled
      ? `No drawable sequence. Need at least two stops in one route/day with numeric SEQNO values and distinct valid locations. ${sequenceDataNote}`.trim()
      : "Turn on to see the delivery sequence.";
    return;
  }
  const pending = [], completed = [], pendingArrows = [], completedArrows = [];
  const badges = [], checks = [];
  const selected = document.getElementById("sequenceRouteSelect").value;
  const delivered = stop => String(stop.row.del_status || "").trim().toLowerCase() === "delivered";
  const bounds = map.getPixelBounds();
  const zoom = map.getZoom();
  let arrowCount = 0;
  let segmentCount = 0;
  sequenceGroups.forEach((group, key) => {
    if (selected !== "all" && selected !== key) return;
    const stops = group.stops;
    stops.forEach(stop => {
      if (!stop.latlng || !delivered(stop)) return;
      const point = map.project(stop.latlng, zoom);
      if (!bounds.contains(point)) return;
      // Projected offsets keep badges the same screen size at every zoom.
      const at = (x, y) => map.unproject(L.point(point.x + x, point.y + y), zoom);
      badges.push([at(-6, -6), at(6, -6), at(6, 6), at(-6, 6)]);
      checks.push([at(-3, 0), at(-1, 2.5), at(3.5, -3)]);
    });
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1], to = stops[i];
      if (!from.latlng || !to.latlng || from.latlng.equals(to.latlng)) continue;
      const done = delivered(from) && delivered(to);
      (done ? completed : pending).push([from.latlng, to.latlng]);
      segmentCount++;
      const a = map.project(from.latlng, zoom), b = map.project(to.latlng, zoom);
      if (a.distanceTo(b) < 24 || arrowCount >= 1500) continue;
      // Clip only arrow placement; preserve the full lines and original direction.
      const clipped = L.LineUtil.clipSegment(a, b, bounds, false);
      if (!clipped) continue;
      const length = clipped[0].distanceTo(clipped[1]);
      if (length < 16) continue;
      const dx = (b.x - a.x) / a.distanceTo(b), dy = (b.y - a.y) / a.distanceTo(b);
      for (let distance = length < 100 ? length / 2 : 45; distance < length && arrowCount < 1500; distance += 100) {
        const tip = L.point(clipped[0].x + dx * distance, clipped[0].y + dy * distance);
        const left = L.point(tip.x - dx * 9 - dy * 4, tip.y - dy * 9 + dx * 4);
        const right = L.point(tip.x - dx * 9 + dy * 4, tip.y - dy * 9 - dx * 4);
        (done ? completedArrows : pendingArrows).push([tip, left, right].map(point => map.unproject(point, zoom)));
        arrowCount++;
      }
    }
  });
  sequenceHalo.setLatLngs([...pending, ...completed]);
  sequencePendingLine.setLatLngs(pending);
  sequenceCompletedLine.setLatLngs(completed);
  sequencePendingArrows.setLatLngs(pendingArrows);
  sequenceCompletedArrows.setLatLngs(completedArrows);
  sequenceDeliveredBadges.setLatLngs(badges);
  sequenceDeliveredChecks.setLatLngs(checks);
  if (!map.hasLayer(sequenceLayer)) sequenceLayer.addTo(map);
  status.textContent = `${segmentCount} connections · original sequence, including delivered stops. ${sequenceDataNote}`.trim();
}

document.getElementById("sequenceLayerToggle").addEventListener("change", scheduleSequenceRender);
document.getElementById("sequenceRouteSelect").addEventListener("change", scheduleSequenceRender);
map.on("zoomend moveend resize", scheduleSequenceRender);

// ================= PROCESS ROUTE EXCEL =================
// Core data flow: first sheet -> row objects -> one Leaflet marker per row.
// Required columns: LATITUDE, LONGITUDE, ROUTE, DAY. Optional: CSADR#, CSSDIR, CSSTRT, CSSFUX
// (address), SIZE, QTY, BINNO (popup), SEQNO (sequence), del_status ("Delivered" marks completed stops).
// Rebuilds sequenceGroups, resets map/selection, then fills routeDayGroups by day or Delivered.
function processExcelBuffer(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(ws);
  rebuildSequenceData(rows);

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
    const route = String(rowRoute(row));
    const day = String(rowDay(row));

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
    ${rowSequence(row) !== null ? `<div><strong>Sequence:</strong> ${rowSequence(row)}</div>` : ""}
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

      // Phone: with Select Stops off, a tap only opens the customer details popup.
      if (window.innerWidth <= 900) return;

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



// ================= SHARED TRUCK / TRAILER LOAD LOG =================
function validateLoadLogEvent(event, name) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const profileId = /^[a-f0-9]{64}$/;
  const text = (value, max) => typeof value === "string" && value.length <= max;
  const quantity = value => Number.isInteger(value) && value >= 0 && value <= 100000;
  let valid = event && event.version === 1 && Number.isFinite(Date.parse(event.createdAt));
  if (event?.kind === "profile") {
    valid &&= profileId.test(event.id) && text(event.name, 80) && event.name.trim().length > 0;
  } else if (event?.kind === "load") {
    valid &&= uuid.test(event.id) && profileId.test(event.profileId) &&
      ["truck", "trailer"].includes(event.vehicleType) && text(event.vehicleName, 60) &&
      quantity(event.trash) && quantity(event.recycling) && event.trash + event.recycling > 0 &&
      Number.isFinite(Date.parse(event.unloadedAt));
  } else if (event?.kind === "void") {
    valid &&= uuid.test(event.id);
  } else valid = false;
  if (!valid || name !== `${event.kind}-${event.id}.json`) throw new Error("Invalid load log record");
  return event;
}

async function readLoadLogEvent(name) {
  const { data } = sb.storage.from(BUCKET).getPublicUrl(`${LOAD_LOG_PREFIX}/${name}`);
  const response = await fetch(`${data.publicUrl}?v=${Date.now()}`, {
    cache: "no-store", signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Load log read failed (${response.status})`);
  return validateLoadLogEvent(await response.json(), name);
}

async function writeLoadLogEvent(event) {
  const name = `${event.kind}-${event.id}.json`;
  validateLoadLogEvent(event, name);
  try {
    const { error } = await sb.storage.from(BUCKET).upload(`${LOAD_LOG_PREFIX}/${name}`,
      new Blob([JSON.stringify(event)], { type: "application/json" }),
      { upsert: false, contentType: "application/json", cacheControl: "0" });
    if (error) throw error;
    return event;
  } catch (error) {
    // A lost response or a retry must not count the same load twice.
    try {
      const existing = await readLoadLogEvent(name);
      if (event.kind !== "load" || JSON.stringify(existing) === JSON.stringify(event)) return existing;
    } catch (_) { /* Preserve the original save failure. */ }
    throw error;
  }
}

function setupLoadLog() {
  const el = id => document.getElementById(id);
  const dialog = el("loadLogDialog");
  const profileSelect = el("loadLogProfile");
  const form = el("loadLogForm");
  const profileForm = el("loadProfileForm");
  const syncStatus = el("loadLogSyncStatus");
  const saveStatus = el("loadLogSaveStatus");
  let cache = new Map();
  let events = [];
  let loaded = false;
  let lastRefreshedAt = null;
  let writing = false;
  let refreshTask = null;
  let refreshTimer;
  let shown = 30;
  let pendingLoad = null;
  let preferredProfile = "";
  try { preferredProfile = localStorage.getItem("cartdelivery.loadProfile") || ""; } catch (_) { /* Preference only. */ }
  const status = (node, message, state = "ready") => {
    node.textContent = message;
    node.dataset.state = state;
  };
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const currentProfile = () => events.find(event => event.kind === "profile" && event.id === profileSelect.value);
  const profileLoads = profile => events.filter(event => event.kind === "load" && event.profileId === profile?.id &&
    (el("loadLogPeriod").value !== "today" || new Date(event.unloadedAt).toDateString() === new Date().toDateString()))
    .sort((a, b) => b.unloadedAt.localeCompare(a.unloadedAt) || b.createdAt.localeCompare(a.createdAt));
  const rememberProfile = () => {
    preferredProfile = profileSelect.value;
    try { localStorage.setItem("cartdelivery.loadProfile", preferredProfile); } catch (_) { /* Preference only. */ }
  };
  const localDateTime = () => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  function updateControls() {
    dialog.dataset.editing = String(!form.hidden || !profileForm.hidden);
    profileSelect.disabled = writing || !form.hidden;
    el("newLoadBtn").disabled = writing || !currentProfile();
    el("newLoadProfileBtn").disabled = writing || !loaded;
    el("refreshLoadLogBtn").disabled = writing || Boolean(refreshTask);
    el("exportLoadLogBtn").disabled = writing || Boolean(refreshTask) || !loaded || !currentProfile();
    el("loadLogFields").disabled = writing;
    [...profileForm.elements].forEach(control => { control.disabled = writing; });
    el("saveLoadBtn").textContent = writing ? "Saving…" : "Save unloaded load";
    el("loadLogList").querySelectorAll("button").forEach(button => { button.disabled = writing; });
  }
  function render() {
    const profiles = events.filter(event => event.kind === "profile").sort((a, b) => a.name.localeCompare(b.name));
    const selected = profileSelect.value || preferredProfile;
    profileSelect.replaceChildren(new Option("Choose a profile", ""), ...profiles.map(profile => new Option(profile.name, profile.id)));
    profileSelect.value = profiles.some(profile => profile.id === selected) ? selected : profiles.length === 1 ? profiles[0].id : "";
    const profile = currentProfile();
    const loads = profileLoads(profile);
    const voided = new Set(events.filter(event => event.kind === "void").map(event => event.id));
    const counted = loads.filter(load => !voided.has(load.id));
    const totals = {
      truckLoadTotal: counted.filter(load => load.vehicleType === "truck").length,
      trailerLoadTotal: counted.filter(load => load.vehicleType === "trailer").length,
      trashCartTotal: counted.reduce((sum, load) => sum + load.trash, 0),
      recycleCartTotal: counted.reduce((sum, load) => sum + load.recycling, 0)
    };
    Object.entries(totals).forEach(([id, value]) => { el(id).textContent = loaded && profile ? value.toLocaleString() : "—"; });
    const list = el("loadLogList");
    list.replaceChildren();
    if (!profile || !loads.length) list.append(node("p", !loaded ? "Load the shared log to see counts." : !profile
      ? profiles.length ? "Choose a profile to see its counts and history." : "Create a profile, such as Burnet, to start counting loads."
      : "No unloaded loads recorded for this profile and period."));
    loads.slice(0, shown).forEach(load => {
      const isVoid = voided.has(load.id);
      const card = node("article", "", `load-log-entry${isVoid ? " is-void" : ""}`);
      const title = `${load.vehicleType === "truck" ? "Truck" : "Trailer"}${load.vehicleName ? ` · ${load.vehicleName}` : ""}`;
      card.append(node("strong", title), node("p", `Unloaded ${new Date(load.unloadedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`),
        node("p", `Approx. ${load.trash.toLocaleString()} trash · ${load.recycling.toLocaleString()} recycling`));
      if (isVoid) card.append(node("span", "Voided · excluded from totals", "load-log-void-label"));
      else {
        const button = node("button", "Void entry");
        button.type = "button";
        button.setAttribute("aria-label", `Void ${title}, ${load.trash + load.recycling} carts`);
        button.addEventListener("click", () => voidLoad(load));
        card.append(button);
      }
      list.append(card);
    });
    el("loadLogShowMore").hidden = loads.length <= shown;
    updateControls();
  }
  async function refresh() {
    if (refreshTask) return refreshTask;
    if (writing) return;
    status(syncStatus, "Checking shared counts…");
    refreshTask = (async () => {
      const names = new Set();
      for (let offset = 0; ; offset += 200) {
        const { data, error } = await sb.storage.from(BUCKET).list(LOAD_LOG_PREFIX, {
          limit: 200, offset, sortBy: { column: "name", order: "asc" }
        });
        if (error) throw error;
        if (!Array.isArray(data)) throw new Error("Could not list load records");
        data.forEach(file => { if (/^(profile|load|void)-[a-f0-9-]+\.json$/.test(file.name)) names.add(file.name); });
        if (data.length < 200) break;
      }
      const missing = [...names].filter(name => !cache.has(name));
      let cursor = 0;
      const downloaded = new Map();
      await Promise.all(Array.from({ length: Math.min(6, missing.length) }, async () => {
        while (cursor < missing.length) {
          const name = missing[cursor++];
          downloaded.set(name, await readLoadLogEvent(name));
        }
      }));
      // Commit a complete snapshot; never show partial totals after a failed read.
      cache = new Map([...cache, ...downloaded]);
      events = [...cache.values()];
      loaded = true;
      lastRefreshedAt = new Date().toISOString();
      render();
      status(syncStatus, `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Refreshes every 30s while open`);
    })().catch(error => {
      console.error("Load log refresh:", error);
      status(syncStatus, loaded ? "Could not refresh. Showing previously loaded counts; try Refresh log." : "Could not load shared counts. Check your connection and tap Refresh log.", "error");
    }).finally(() => { refreshTask = null; updateControls(); });
    updateControls();
    return refreshTask;
  }
  async function saveEvent(event) {
    if (refreshTask) await refreshTask;
    const saved = await writeLoadLogEvent(event);
    cache.set(`${saved.kind}-${saved.id}.json`, saved);
    events = [...cache.values()];
    return saved;
  }
  async function voidLoad(load) {
    if (writing || !confirm("Void this load and remove it from the totals? It will remain in the history. To correct it, record a replacement load.")) return;
    writing = true;
    updateControls();
    status(saveStatus, "Saving correction…");
    try {
      await saveEvent({ version: 1, kind: "void", id: load.id, createdAt: new Date().toISOString() });
      status(saveStatus, "Saved — load voided on the shared log.", "saved");
    } catch (error) {
      console.error("Void load:", error);
      status(saveStatus, "Correction not confirmed. Counts are unchanged; try again.", "error");
    } finally { writing = false; render(); }
  }
  profileForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (writing || !profileForm.reportValidity()) return;
    const name = el("loadProfileName").value.trim().replace(/\s+/g, " ");
    if (!name) return;
    writing = true;
    updateControls();
    status(saveStatus, "Saving profile…");
    try {
      const normalized = name.normalize("NFKC").toLowerCase();
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
      const id = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const saved = await saveEvent({ version: 1, kind: "profile", id, name, createdAt: new Date().toISOString() });
      profileSelect.value = "";
      preferredProfile = saved.id;
      profileForm.hidden = true;
      render();
      rememberProfile();
      status(saveStatus, `Saved — ${saved.name} profile is shared across phones.`, "saved");
    } catch (error) {
      console.error("Save load profile:", error);
      status(saveStatus, "Profile save not confirmed. Keep the name and try again.", "error");
    } finally { writing = false; updateControls(); }
  });
  form.addEventListener("input", () => { pendingLoad = null; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (writing || !currentProfile() || !form.reportValidity()) return;
    const trash = Number(el("loadTrashQuantity").value);
    const recycling = Number(el("loadRecycleQuantity").value);
    if (!Number.isInteger(trash) || !Number.isInteger(recycling) || trash < 0 || recycling < 0 || trash + recycling === 0) {
      status(saveStatus, "Enter a whole number of carts for at least one cart type.", "error");
      return;
    }
    writing = true;
    updateControls();
    status(saveStatus, "Saving unloaded load…");
    try {
      pendingLoad ||= {
        version: 1, kind: "load", id: crypto.randomUUID(), profileId: profileSelect.value,
        vehicleType: el("loadVehicleType").value, vehicleName: el("loadVehicleName").value.trim(),
        trash, recycling, unloadedAt: new Date(el("loadOccurredAt").value).toISOString(), createdAt: new Date().toISOString()
      };
      await saveEvent(pendingLoad);
      pendingLoad = null;
      form.hidden = true;
      rememberProfile();
      status(saveStatus, "Saved — unloaded load added to this profile on all phones.", "saved");
    } catch (error) {
      console.error("Save unloaded load:", error);
      status(saveStatus, "Save not confirmed. Your entry is kept here; retry to confirm it without counting it twice.", "error");
    } finally { writing = false; render(); }
  });
  el("newLoadBtn").addEventListener("click", () => {
    if (!currentProfile() || writing) return;
    form.reset();
    pendingLoad = null;
    el("loadOccurredAt").value = localDateTime();
    el("loadFormProfile").textContent = `Profile: ${currentProfile().name}`;
    profileForm.hidden = true;
    form.hidden = false;
    status(saveStatus, "");
    updateControls();
    el("loadVehicleType").focus();
  });
  el("cancelLoadBtn").addEventListener("click", () => { form.hidden = true; pendingLoad = null; updateControls(); });
  el("newLoadProfileBtn").addEventListener("click", () => {
    form.hidden = true;
    profileForm.hidden = false;
    el("loadProfileName").value = "";
    status(saveStatus, "");
    updateControls();
    el("loadProfileName").focus();
  });
  el("cancelLoadProfileBtn").addEventListener("click", () => { profileForm.hidden = true; updateControls(); });
  profileSelect.addEventListener("change", () => { shown = 30; status(saveStatus, ""); rememberProfile(); render(); });
  el("loadLogPeriod").addEventListener("change", () => { shown = 30; render(); });
  el("loadLogShowMore").addEventListener("click", () => { shown += 30; render(); });
  el("exportLoadLogBtn").addEventListener("click", () => {
    const profile = currentProfile();
    if (!loaded || !profile || writing || refreshTask) return;
    try {
      const exportedAt = new Date();
      const period = el("loadLogPeriod").value === "today" ? "Today" : "All dates";
      const loads = profileLoads(profile);
      const voids = new Map(events.filter(event => event.kind === "void").map(event => [event.id, event]));
      const counted = loads.filter(load => !voids.has(load.id));
      const wb = XLSX.utils.book_new();
      const summary = XLSX.utils.aoa_to_sheet([
        ["Profile", profile.name], ["Period", period],
        ["Truck loads", counted.filter(load => load.vehicleType === "truck").length],
        ["Trailer loads", counted.filter(load => load.vehicleType === "trailer").length],
        ["Approx. trash carts", counted.reduce((sum, load) => sum + load.trash, 0)],
        ["Approx. recycling carts", counted.reduce((sum, load) => sum + load.recycling, 0)],
        ["Voided entries (excluded from totals)", loads.length - counted.length],
        ["Exported at (UTC)", exportedAt.toISOString()],
        ["Last full cloud refresh (UTC)", lastRefreshedAt || ""],
        ["Display time zone", Intl.DateTimeFormat().resolvedOptions().timeZone],
        ["Data", "Confirmed records currently loaded, including subsequent saves on this phone. Refresh log for the latest records from other phones."],
        ["Profile ID", profile.id]
      ]);
      summary["!cols"] = [{ wch: 38 }, { wch: 85 }];
      const history = XLSX.utils.aoa_to_sheet([
        ["Profile", "Vehicle type", "Vehicle name / number", "Unloaded at (UTC)", "Unloaded at (local)",
          "Approx. trash carts", "Approx. recycling carts", "Total carts", "Status", "Recorded at (UTC)", "Voided at (UTC)", "Load ID"],
        ...loads.map(load => [profile.name, load.vehicleType === "truck" ? "Truck" : "Trailer", load.vehicleName,
          load.unloadedAt, new Date(load.unloadedAt).toLocaleString(), load.trash, load.recycling,
          load.trash + load.recycling, voids.has(load.id) ? "Voided" : "Counted", load.createdAt,
          voids.get(load.id)?.createdAt || "", load.id])
      ]);
      history["!cols"] = [24, 14, 24, 26, 26, 20, 24, 14, 12, 26, 26, 38].map(wch => ({ wch }));
      history["!autofilter"] = { ref: history["!ref"] };
      XLSX.utils.book_append_sheet(wb, summary, "Summary");
      XLSX.utils.book_append_sheet(wb, history, "Load History");
      const name = profile.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 70) || "Profile";
      const stamp = exportedAt.toISOString().replace(/[:.]/g, "-");
      XLSX.writeFile(wb, `${name}_Loads_${period === "Today" ? "Today" : "AllDates"}_${stamp}.xlsx`, { compression: true });
      status(saveStatus, `Excel download started — ${profile.name}, ${period.toLowerCase()}.`, "saved");
    } catch (error) {
      console.error("Load log export:", error);
      status(saveStatus, "Could not create the Excel download. Try again.", "error");
    }
  });
  el("refreshLoadLogBtn").addEventListener("click", refresh);
  el("loadLogBtn").addEventListener("click", () => {
    dialog.showModal();
    render();
    refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  });
  el("closeLoadLogBtn").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => clearInterval(refreshTimer));
  document.addEventListener("visibilitychange", () => { if (dialog.open && !document.hidden) refresh(); });
  window.addEventListener("online", () => { if (dialog.open) refresh(); });
}

// ================= LIST FILES FROM CLOUD =================
// Saved-files popup: "Cart Delivery" tab (default, shown first) lists files the user chose, stored
// shared across phones via a JSON file in the bucket (SHARED_TAB_FILE; localStorage is a cache); "All Files" lists the whole bucket.
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

// The Cart Delivery list is shared across all phones: it is stored as a small JSON file in the
// same Supabase bucket (SHARED_TAB_FILE) and hidden from the file lists. localStorage is only a
// local cache / one-time migration source. Reads never overwrite the shared file on failure.
const SHARED_TAB_FILE = "_cart-delivery-tab.json";
const LOAD_LOG_PREFIX = "_cart-loads";
let sharedTabLoaded = false;

async function loadSharedCartDeliveryNames() {
  const { data } = sb.storage.from(BUCKET).getPublicUrl(SHARED_TAB_FILE);
  const response = await fetch(data.publicUrl + "?v=" + Date.now(), { cache: "no-store" });
  if (response.ok) {
    const names = await response.json();
    if (!Array.isArray(names)) throw new Error("Shared Cart Delivery list has an invalid format.");
    cartDeliveryFileNames = new Set(names.filter(name => typeof name === "string"));
  } else if (response.status === 400 || response.status === 404) {
    // Not created yet: seed it from this browser's previous local list (if any).
    if (cartDeliveryFileNames.size) await saveCartDeliveryFileNames();
  } else {
    throw new Error("Could not read shared Cart Delivery list (HTTP " + response.status + ").");
  }
  sharedTabLoaded = true;
  try {
    localStorage.setItem(CART_DELIVERY_FILES_KEY, JSON.stringify([...cartDeliveryFileNames]));
  } catch (error) { /* cache only */ }
}

// Uploads the shared list. Throws on failure so callers can revert their change.
async function saveCartDeliveryFileNames() {
  const body = new Blob([JSON.stringify([...cartDeliveryFileNames])], { type: "application/json" });
  const { error } = await sb.storage.from(BUCKET).upload(SHARED_TAB_FILE, body, {
    upsert: true,
    contentType: "application/json"
  });
  if (error) throw error;
  try {
    localStorage.setItem(CART_DELIVERY_FILES_KEY, JSON.stringify([...cartDeliveryFileNames]));
  } catch (error) { /* cache only */ }
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
  try {
    await loadSharedCartDeliveryNames();
  } catch (error) {
    console.error(error);
    if (activeSavedFilesTab === "cartDelivery" && !sharedTabLoaded) {
      alert("Could not load the shared Cart Delivery list. Check your connection and try again.");
    }
  }
  const { data, error } = await sb.storage.from(BUCKET).list();
  if (error) {
    console.error("Could not list saved files:", error);
    alert("Could not load saved files. Please try again.");
    return;
  }

  const ul = document.getElementById("savedFiles");
  ul.innerHTML = "";

  // Legacy summary files are not delivery datasets; keep them out of this list.
  const routeFiles = {};
  data.forEach(file => {
    if (file.name !== SHARED_TAB_FILE && file.name !== LOAD_LOG_PREFIX && !/route[\s_.-]*summary/i.test(file.name)) routeFiles[file.name] = file.name;
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
    organizeBtn.onclick = async () => {
      const previous = new Set(cartDeliveryFileNames);
      if (cartDeliveryFileNames.has(routeName)) {
        cartDeliveryFileNames.delete(routeName);
      } else {
        cartDeliveryFileNames.add(routeName);
      }
      organizeBtn.disabled = true;
      try {
        await saveCartDeliveryFileNames();
      } catch (error) {
        console.error("Could not save Cart Delivery list:", error);
        cartDeliveryFileNames = previous;
        alert("Could not update the Cart Delivery tab. Check your connection and try again.");
      }
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

    hideLoading("File Loaded Successfully ✅");
    document.getElementById("fileManagerModal").style.display = "none";
    closeMobileMenu();

  } catch (err) {
    console.error(err);
    hideLoading();
    alert("Error loading file.");
  }
};



    li.appendChild(openBtn);

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

  const { error } = await sb.storage.from(BUCKET).remove(toDelete);
  if (error) {
    console.error("Could not delete saved file:", error);
    alert("Could not delete this file. Please try again.");
    return;
  }

  if (cartDeliveryFileNames.delete(routeName)) {
    try { await saveCartDeliveryFileNames(); } catch (error) { console.error(error); }
  }
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
    closeMobileMenu();
    listFiles();

    hideLoading("Upload Complete ✅");

  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    hideLoading();
    alert("Upload failed: " + error.message);
  }
}

// ===== PLACE DELIVERY CONTROLS BASED ON SCREEN SIZE =====
// Moves existing buttons between the phone dock (#deliveryControls, below the map) and the
// desktop right sidebar (#selectionBox). Runs on load and resize. Add new shared actions to
// BOTH branches, or they will only appear on one layout.
function closeMobileMenu() {
  document.querySelector(".sidebar").classList.remove("open");
  document.querySelector(".mobile-overlay").classList.remove("show");
  const button = document.getElementById("mobileMenuBtn");
  button.textContent = "Menu";
  button.setAttribute("aria-expanded", "false");
}

function placeDeliveryControls() {
  const locateBtn = document.getElementById("locateMeBtn");
  const completeBtn = document.getElementById("completeStopsBtn");
  const headerContainer = document.querySelector(".mobile-header-buttons");
  const desktopContainer = document.getElementById("desktopLocateContainer");
  const selectionBox = document.getElementById("selectionBox");
  const dock = document.getElementById("deliveryControls");
  const quickActions = document.getElementById("deliveryQuickActions");
  const moreActions = document.getElementById("deliveryMoreActions");
  const moreBtn = document.getElementById("deliveryMoreBtn");
  const clearBtn = document.getElementById("clearSelectionBtn");
  const refreshBtn = document.getElementById("hardRefreshBtn");
  const undoBtn = document.getElementById("undoDeliveredBtn");
  const streetLabel = document.getElementById("streetLabelToggle").parentElement;
  const saveStatus = document.getElementById("deliverySaveStatus");
  const copyLocationBtn = document.getElementById("copyLocationBtn");
  const loadLogBtn = document.getElementById("loadLogBtn");

  if (window.innerWidth <= 900) {
    quickActions.insertBefore(locateBtn, moreBtn);
    quickActions.insertBefore(copyLocationBtn, moreBtn);
    moreActions.append(clearBtn, undoBtn, streetLabel, refreshBtn);
    moreActions.prepend(loadLogBtn);
    dock.insertBefore(saveStatus, quickActions);
  } else {
    selectionBox.insertBefore(clearBtn, desktopContainer);
    desktopContainer.append(locateBtn, copyLocationBtn, completeBtn, saveStatus, undoBtn, streetLabel, loadLogBtn);
    headerContainer.appendChild(refreshBtn);
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

setupLocationCopy();
setupLoadLog();

// ===== RIGHT SIDEBAR TOGGLE =====

// ===== RIGHT SIDEBAR TOGGLE =====
const selectionBox = document.getElementById("selectionBox");
const toggleSelectionBtn = document.getElementById("toggleSelectionBtn");
const clearBtn = document.getElementById("clearSelectionBtn");
const pageHeader = document.querySelector("header");

// ===== COMPLETE STOPS BUTTON =====


  
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

// Keep the nearby-stop picker above the dock, including the home-indicator inset.
const deliveryControls = document.getElementById("deliveryControls");
const moreActions = document.getElementById("deliveryMoreActions");
const moreBtn = document.getElementById("deliveryMoreBtn");
moreBtn.addEventListener("click", () => {
  const expanded = moreActions.hidden;
  moreActions.hidden = !expanded;
  moreBtn.textContent = expanded ? "Less" : "More";
  moreBtn.setAttribute("aria-expanded", String(expanded));
});

function syncMobileSelectionLayout() {
  if (window.innerWidth > 900) return;
  const root = document.documentElement;
  root.style.setProperty("--mobile-controls-height", `${deliveryControls.offsetHeight}px`);
  root.style.setProperty("--mobile-header-height", `${pageHeader.offsetHeight}px`);
}

const mobileLayoutObserver = new ResizeObserver(() => {
  syncMobileSelectionLayout();
  syncMobileSidebarLayout();
  syncSelectionBoxTop();
  map.invalidateSize({ pan: false });
});
mobileLayoutObserver.observe(deliveryControls);
mobileLayoutObserver.observe(pageHeader);
window.addEventListener("resize", syncMobileSelectionLayout);
syncMobileSelectionLayout();

if (mobileMenuBtn && sidebar && overlay) {

  mobileMenuBtn.addEventListener("click", () => {
    syncMobileSidebarLayout();
    const open = sidebar.classList.toggle("open");

    mobileMenuBtn.textContent = open ? "Close" : "Menu";
    mobileMenuBtn.setAttribute("aria-expanded", String(open));
    overlay.classList.toggle("show", open);
    if (open) {
      sidebar.scrollTop = 0;
      requestAnimationFrame(() => {
        sidebar.scrollTop = 0;
      });
    }

    setTimeout(() => map.invalidateSize(), 200);
  });

  overlay.addEventListener("click", closeMobileMenu);
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
    selectionBox.classList.remove("show");
    updateSelectionCount();
  }

  mobileSelBtn.addEventListener("click", () => {
    setMobileStopSelectionMode(!mobileStopSelectionMode);
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
    mobileSelBtn.setAttribute("aria-pressed", String(mobileStopSelectionMode));
    mobileSelBtn.setAttribute(
      "aria-label",
      mobileStopSelectionMode
        ? `Finish selecting ${count} stops`
        : count
          ? `Edit selection of ${count} stops`
          : "Start tap selection for closely spaced stops"
    );
    mobileSelBtn.title = mobileStopSelectionMode
      ? "Tap stops on the map, then tap here when finished."
      : "Tap to select or deselect stops. Delivery actions are below the map.";
  };
  updateSelectionCount();
}


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
    rebuildSequenceData([]);


  });
}


// ===== LIVE GPS BUTTON =====
const locateBtn = document.getElementById("locateMeBtn");

if (locateBtn) {
  let tracking = false;

  locateBtn.addEventListener("click", () => {
    if (!tracking) {
      startLiveTracking();
      locateBtn.textContent = "Stop GPS";
      locateBtn.setAttribute("aria-pressed", "true");
      locateBtn.setAttribute("aria-label", "Stop following my position");
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


      locateBtn.textContent = "Locate";
      locateBtn.setAttribute("aria-pressed", "false");
      locateBtn.setAttribute("aria-label", "Locate me and follow my position");
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

    const pad = n => String(n).padStart(2, "0");
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

    const baseName = getDownloadBaseName(window._currentFilePath);

    const newFileName = `${baseName}_Backup_${timestamp}.xlsx`;
    XLSX.writeFile(window._currentWorkbook, newFileName, { compression: true });
  });
}




// Street labels: when the "Street Labels" checkbox is on and zoom >= STREET_LABEL_MIN_ZOOM,
// open a tooltip for up to 150 visible stops. Runs on zoomend, moveend and checkbox change.
const STREET_LABEL_MIN_ZOOM = 16;
function updateStreetLabels() {
  const bounds = map.getBounds();
  const show = window.streetLabelsEnabled && map.getZoom() >= STREET_LABEL_MIN_ZOOM;
  let count = 0;
  Object.values(routeDayGroups).forEach(group => {
    group.layers.forEach(layer => {
      if (!layer._hasStreetLabel) return;
      if (show && count < 150 && map.hasLayer(layer) && bounds.contains(layer.getLatLng())) {
        layer.openTooltip();
        count++;
      } else {
        layer.closeTooltip();
      }
    });
  });
}
map.on("moveend", updateStreetLabels);
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

    });
  });
  updateStreetLabels();
});

  
// Position shared controls for the current screen size.
placeDeliveryControls();
window.addEventListener("resize", placeDeliveryControls);


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
async function serializeDeliveryWorkbook(workbook, bookType) {
  const options = { bookType, type: "buffer" };
  if (window.fflate) {
    try {
      // Repack the Excel ZIP with stronger compression; every entry stays intact.
      const raw = XLSX.write(workbook, { ...options, compression: false });
      const entries = fflate.unzipSync(raw);
      return await new Promise((resolve, reject) => {
        let terminate;
        const timeout = setTimeout(() => {
          terminate?.();
          reject(new Error("Workbook compression timed out"));
        }, 20000);
        try {
          terminate = fflate.zip(entries, { level: 6 }, (error, bytes) => {
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(bytes);
          });
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    } catch (error) {
      console.warn("Using standard workbook compression:", error);
    }
  }
  return XLSX.write(workbook, { ...options, compression: true });
}

// Build a separate workbook so failed saves leave the current route unchanged.
async function saveWorkbookToCloud(rows, workbook, filePath, onProgress = () => {}) {
  const started = performance.now();
  onProgress("Preparing file");
  // Let the phone paint the saving feedback before spreadsheet serialization.
  await new Promise(resolve => setTimeout(resolve, 20));
  const nextWorkbook = {
    ...workbook,
    Sheets: {
      ...workbook.Sheets,
      [workbook.SheetNames[0]]: XLSX.utils.json_to_sheet(rows)
    }
  };
  const bookType = filePath.toLowerCase().endsWith(".xlsm") ? "xlsm" : "xlsx";
  const wbArray = await serializeDeliveryWorkbook(nextWorkbook, bookType);
  const prepared = performance.now();
  const metrics = {
    bytes: wbArray.byteLength,
    preparationMs: Math.round(prepared - started),
    uploadMs: null,
    confirmed: false
  };
  window.lastDeliverySaveMetrics = metrics;
  const size = wbArray.byteLength < 1024 * 1024
    ? `${Math.ceil(wbArray.byteLength / 1024)} KB`
    : `${(wbArray.byteLength / (1024 * 1024)).toFixed(1)} MB`;
  onProgress(`Uploading ${size}`);
  try {
    const { error } = await sb.storage.from(BUCKET).upload(filePath, wbArray, {
      upsert: true,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    if (error) throw error;
    metrics.confirmed = true;
  } finally {
    metrics.uploadMs = Math.round(performance.now() - prepared);
  }
  return nextWorkbook;
}

// Marks selected stops Delivered (markDelivered=true) or restores them (false).
// Flow: collect selected rows -> upload a new workbook to Supabase -> only on success mutate
// row.del_status, move markers between routeDayGroups keys, refresh controls and sequence styling.
// Uploads overwrite the whole file, so never mutate rows before the upload succeeds.
// Assumes a single editing phone at a time (viewers only read); there is no merge with remote changes.
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
  const started = performance.now();
  let savePhase = "Preparing file";
  const showSaveProgress = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    const elapsed = seconds >= 2 ? ` · ${seconds}s` : "";
    const waiting = seconds >= 15 ? " · Keep app open" : "";
    setDeliverySaveStatus("saving", `Saving ${count} ${stopLabel}… ${savePhase}${elapsed}${waiting}`);
  };
  showSaveProgress();
  const progressTimer = setInterval(showSaveProgress, 1000);

  let savedWorkbook;
  try {
    savedWorkbook = await saveWorkbookToCloud(nextRows, workbook, filePath, phase => {
      savePhase = phase;
      showSaveProgress();
    });
  } catch (error) {
    console.error("Cloud Save Error:", error);
    setDeliverySaveStatus("error", "Not saved — check your connection and try again.");
    return;
  } finally {
    clearInterval(progressTimer);
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
      const nextKey = `${rowRoute(row)}|${markDelivered ? "Delivered" : rowDay(row)}`;
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
    scheduleSequenceRender();
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

// PWA: register the service worker (home-screen install, offline shell, cached tiles).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
