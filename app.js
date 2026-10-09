/*
 * Cart Delivery app - single-file client logic (no build step, no modules).
 * See README.md for the architecture guide and AGENTS.md for editing rules.
 *
 * Map of this file (search for the "=====" section banners):
 *   1. Delivery button/status helpers (top of file)
 *   2. Supabase config + global state (window._currentRows / _currentWorkbook / _currentFilePath)
 *   3. Header tools menu, Sun Mode, GPS locate / live tracking / Copy Location
 *   4. Leaflet map setup, basemaps, city limits/address numbers, Leaflet.Draw polygon selection
 *   5. Selection engine: createSelectionTester, isStopSelected, toggleIndividualStopSelection,
 *      nearby-stop chooser (phone tap selection), updateSelectionCount
 *   6. Marker creation, quantity badges, route/day filters, statistics
 *   7. Sequence arrows: rowSequence, rebuildSequenceData, renderSequenceLayer
 *   8. processExcelBuffer: turns a workbook into markers and sequence groups (core data flow)
 *   9. Shared truck / trailer load log and Excel export
 *  10. Saved files (Supabase storage list/upload, shared Cart Delivery tab)
 *  11. placeDeliveryControls + initApp: layout wiring, mobile menu, selection mode, reset, ranked address search
 *  12. Cloud save of delivery status (saveSelectedDeliveryStatus), collapsibles, button events
 *
 * Key invariants:
 *   - Every marker has marker._rowRef (the spreadsheet row object) and marker._base ({lat, lon, symbol}).
 *   - routeDayGroups["ROUTE|DAY"] or ["ROUTE|Delivered"] = { layers: [markers] } is the source of truth for markers.
 *   - Only visible markers can be selected: individuallySelectedMarkers, or inside the drawn polygon and
 *     not in individuallyDeselectedMarkers. Always use isStopSelected(); never read marker styles to decide.
 *   - sequenceGroups keeps original route/day order and row references, including hidden delivered stops.
 *     Delivery badges and segment colors read those rows only after a confirmed save/undo.
 *   - del_qty tracks carts delivered; isDeliveredRow() supports legacy del_status-only files. Saves rewrite the sheet.
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
let resequenceBusy = false;
let optimoLocationPicker = null;
let selectedPendingStopCount = 0;
let resetAddressSearch = () => {};
let refreshAddressSearch = () => {};

function updateDeliveryButtons() {
  const count = selectedPendingStopCount;
  const perRecord = document.getElementById("multipleCartsOnly").checked;
  const label = deliverySaveInProgress
    ? "Saving…"
    : perRecord ? "Enter carts delivered" : "Deliver 1 cart per stop";

  ["completeStopsBtn", "completeStopsBtnMobile"].forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    button.textContent = label;
    button.disabled = deliverySaveInProgress || resequenceBusy || count === 0;
    button.setAttribute("aria-busy", String(deliverySaveInProgress));
    button.title = !count ? "Select undelivered stops on the map first" : perRecord
      ? "Enter the carts delivered this visit for each selected record"
      : "Add one delivered cart to each selected stop. Use Record carts to specify a different count.";
  });
  const undoButton = document.getElementById("undoDeliveredBtn");
  if (undoButton) undoButton.disabled = deliverySaveInProgress || resequenceBusy;
  const cartButton = document.getElementById("recordCartsBtn");
  if (cartButton) {
    cartButton.disabled = deliverySaveInProgress || resequenceBusy || Number(document.getElementById("selectionCount").textContent) === 0;
    cartButton.textContent = document.getElementById("multipleCartsOnly").checked ? "Record carts · QTY 2+ filter on" : "Record carts";
  }
}

function updatePendingDeliveryCount(markers) {
  selectedPendingStopCount = [...markers].filter(marker =>
    marker._rowRef &&
    !isDeliveredRow(marker._rowRef)
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
    if (!optimoLocationPicker) map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 1.2 });

   

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
map.attributionControl.setPrefix(false);
function placeMapCredits() {
  const position = window.innerWidth <= 900 ? "topright" : "bottomleft";
  if (map.attributionControl.getPosition() !== position) map.attributionControl.setPosition(position);
  // Desktop map height can extend below the viewport; keep credits on screen.
  const overflow = position === "bottomleft" ? Math.max(0, map.getContainer().getBoundingClientRect().bottom - window.innerHeight) : 0;
  map.attributionControl.getContainer().style.setProperty("--credits-bottom-overflow", `${Math.ceil(overflow)}px`);
}
placeMapCredits();
window.addEventListener("resize", placeMapCredits);
map.on("resize", placeMapCredits);
// Shared Canvas renderer for high-performance drawing
const canvasRenderer = L.canvas({ padding: 0.5 });
const quantityPane = map.createPane("quantityPane");
quantityPane.style.zIndex = "450";
quantityPane.style.pointerEvents = "none";
const quantityBadgesToggle = document.getElementById("quantityBadgesToggle");
const deliveryOverlayButtons = [...document.querySelectorAll(".delivery-overlay-buttons button")];
deliveryOverlayButtons.forEach(button => button.addEventListener("click", () => {
  const opening = button.getAttribute("aria-expanded") !== "true";
  deliveryOverlayButtons.forEach(control => {
    const expanded = control === button && opening;
    control.setAttribute("aria-expanded", String(expanded));
    document.getElementById(control.getAttribute("aria-controls")).hidden = !expanded;
  });
}));
const QUANTITY_BADGES_KEY = "cartdelivery.quantityBadges";
try { quantityBadgesToggle.checked = localStorage.getItem(QUANTITY_BADGES_KEY) !== "off"; } catch (_) { /* Preference only. */ }
quantityPane.hidden = !quantityBadgesToggle.checked;
quantityBadgesToggle.addEventListener("change", () => {
  // Hide the pane so toggling does not change stop visibility or selection.
  quantityPane.hidden = !quantityBadgesToggle.checked;
  try { localStorage.setItem(QUANTITY_BADGES_KEY, quantityBadgesToggle.checked ? "on" : "off"); } catch (_) { /* Preference only. */ }
});


// ===== BASE MAP LAYERS =====
const tileOptions = { updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1 };
const esriAttribution = 'Tiles © <a href="https://www.esri.com/">Esri</a> & contributors';
const austinAttribution = '<a href="https://maps.austintexas.gov/">City of Austin GIS</a>';
const austinAerialBounds = L.latLngBounds(
  L.CRS.EPSG3857.unproject(L.point(-10944692.02656832, 3492186.76525471)),
  L.CRS.EPSG3857.unproject(L.point(-10835272.923456734, 3587085.514789461))
);
const baseMaps = {
  streets: L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      ...tileOptions,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      maxNativeZoom: 19
    }
  ),

  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      ...tileOptions,
      attribution: esriAttribution,
      maxZoom: 20,
      maxNativeZoom: 19
    }
  ),
  clarity: L.tileLayer(
    "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { ...tileOptions, attribution: esriAttribution, maxZoom: 20, maxNativeZoom: 19 }
  ),
  light: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { ...tileOptions, attribution: esriAttribution, maxZoom: 20, maxNativeZoom: 16 }
  ),
  dark: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { ...tileOptions, attribution: esriAttribution, maxZoom: 20, maxNativeZoom: 16 }
  ),
  austin: L.tileLayer(
    "https://maps.austintexas.gov/gis/Image/MapTiled/AerialImagery_WebMercator/MapServer/tile/{z}/{y}/{x}",
    { ...tileOptions, attribution: austinAttribution, bounds: austinAerialBounds, noWrap: true, maxZoom: 20, maxNativeZoom: 16 }
  )
};
// ===== SATELLITE STREET NAME OVERLAY (LIGHTWEIGHT) =====
const satelliteLabelsLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
  {
    ...tileOptions,
    attribution: esriAttribution,
    maxZoom: 20,
    maxNativeZoom: 19,
    opacity: 1
  }
);

let activeBaseMap = "streets";
const aerialBaseMaps = new Set(["satellite", "clarity", "austin"]);
function syncBasemapLabels() {
  const show = aerialBaseMaps.has(activeBaseMap) && map.getZoom() >= 15;
  if (show && !map.hasLayer(satelliteLabelsLayer)) satelliteLabelsLayer.addTo(map);
  else if (!show && map.hasLayer(satelliteLabelsLayer)) map.removeLayer(satelliteLabelsLayer);
  const status = document.getElementById("baseMapStatus");
  status.textContent = activeBaseMap === "austin" ? (austinAerialBounds.contains(map.getCenter())
    ? "Austin-area aerials; detail is limited at close zooms."
    : "Outside Austin aerial coverage. Choose another Map View.")
    : activeBaseMap === "clarity" ? "Clearer imagery may be older than the regular satellite view."
    : ["light", "dark"].includes(activeBaseMap) && map.getZoom() > 16 ? "Minimal map detail is limited at close zooms. Streets (Detailed) shows finer detail." : "";
}

function setBaseMap(name) {
  if (!baseMaps[name]) return;
  Object.entries(baseMaps).forEach(([key, layer]) => { if (key !== name && map.hasLayer(layer)) map.removeLayer(layer); });
  activeBaseMap = name;
  if (!map.hasLayer(baseMaps[name])) baseMaps[name].addTo(map);
  syncBasemapLabels();
}
document.getElementById("baseMapSelect").addEventListener("change", event => setBaseMap(event.target.value));
map.on("zoomend moveend", syncBasemapLabels);

// ===== OPTIONAL CITY LIMITS (SERVER-RENDERED TILES) =====
const CITY_LIMITS_MIN_ZOOM = 9;
const CITY_LIMITS_WMS = "https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Current/MapServer/WMSServer";
const cityLimitsToggle = document.getElementById("cityLimitsToggle");
const cityLimitsStatus = document.getElementById("cityLimitsStatus");
const cityLimitsPane = map.createPane("cityLimitsPane");
cityLimitsPane.style.zIndex = "280";
cityLimitsPane.style.pointerEvents = "none";
const cityLimitsLayer = L.tileLayer.wms(CITY_LIMITS_WMS, {
  ...tileOptions,
  pane: "cityLimitsPane",
  className: "city-limits-tiles",
  layers: "49,48", // WMS IDs differ from REST: incorporated outlines/names, no census-only places.
  format: "image/png",
  transparent: true,
  version: "1.1.1",
  attribution: '<a href="https://tigerweb.geo.census.gov/tigerwebmain/">U.S. Census Bureau</a>',
  tileSize: 512,
  keepBuffer: 0,
  noWrap: true,
  minZoom: CITY_LIMITS_MIN_ZOOM,
  maxZoom: 20
});
let cityLimitsLoadFailed = false;
function updateCityLimitsStatus() {
  cityLimitsStatus.textContent = !cityLimitsToggle.checked ? "Off. City boundaries work with any Map View."
    : map.getZoom() < CITY_LIMITS_MIN_ZOOM ? "Zoom in to show city limits."
    : cityLimitsLoadFailed ? "Some city limits could not load. Toggle off/on to retry."
    : cityLimitsLayer.isLoading() ? "Loading city limits…"
    : "Pink outlines show city limits where present. Zoom in for city names.";
}
function syncCityLimits() {
  const show = cityLimitsToggle.checked && map.getZoom() >= CITY_LIMITS_MIN_ZOOM;
  if (show && !map.hasLayer(cityLimitsLayer)) {
    cityLimitsLoadFailed = false;
    cityLimitsLayer.addTo(map);
  } else if (!show && map.hasLayer(cityLimitsLayer)) map.removeLayer(cityLimitsLayer);
  updateCityLimitsStatus();
}
cityLimitsLayer.on("loading", () => { cityLimitsLoadFailed = false; updateCityLimitsStatus(); });
cityLimitsLayer.on("tileerror", () => { cityLimitsLoadFailed = true; updateCityLimitsStatus(); });
cityLimitsLayer.on("load", updateCityLimitsStatus);
cityLimitsToggle.addEventListener("change", syncCityLimits);
map.on("zoomend", syncCityLimits);

// ================= POLYGON SELECT =================


// when polygon created
// ================= POLYGON SELECT =================
let drawnLayer = new L.FeatureGroup();
map.addLayer(drawnLayer);
const individuallySelectedMarkers = new Set();
const individuallyDeselectedMarkers = new Set();
const highlightedMarkers = new Set();
let mobileStopSelectionMode = false;

// ===== OPTIONAL CITY ADDRESS NUMBERS =====
const ADDRESS_NUMBER_MIN_ZOOM = 18;
const ADDRESS_NUMBER_FETCH_LIMIT = 400;
const ADDRESS_NUMBER_QUERY = "https://maps.austintexas.gov/gis/rest/Shared/Property/MapServer/0/query";
const addressNumbersToggle = document.getElementById("addressNumbersToggle");
const addressNumbersStatus = document.getElementById("addressNumbersStatus");
const addressNumberPane = map.createPane("addressNumberPane");
addressNumberPane.style.zIndex = "300";
addressNumberPane.style.pointerEvents = "none";
let addressNumbersDrawing = false;

function addressNumberPauseReason() {
  if (!addressNumbersToggle.checked) return "Off. City address numbers are separate from delivery stops.";
  if (mobileStopSelectionMode || addressNumbersDrawing) return "Paused while selecting or drawing stops.";
  if (map.getZoom() < ADDRESS_NUMBER_MIN_ZOOM) return "Zoom in closer to show address numbers.";
  if (!austinAerialBounds.pad(0.25).intersects(map.getBounds())) return "Address numbers cover the Austin area only.";
  return "";
}

const CityAddressNumbers = L.Layer.extend({
  onAdd() {
    this._canvas = L.DomUtil.create("canvas", "city-address-canvas", addressNumberPane);
    this._cache = new Map();
    this._data = [];
    this._ticket = (this._ticket || 0) + 1;
    map.attributionControl.addAttribution(austinAttribution);
    this.schedule();
  },
  onRemove() {
    this.cancel();
    L.DomUtil.remove(this._canvas);
    this._cache.clear();
    this._data = [];
    map.attributionControl.removeAttribution(austinAttribution);
  },
  getEvents() {
    return { movestart: this.pause, zoomstart: this.pause, moveend: this.schedule, zoomend: this.schedule, resize: this.resizeCanvas };
  },
  cancel() {
    clearTimeout(this._timer);
    this._ticket++;
    if (this._request) this._request.abort();
    this._request = null;
  },
  pause() {
    this.cancel();
    this._canvas.hidden = true;
  },
  resizeCanvas() {
    this.pause();
    this.schedule();
  },
  schedule() {
    clearTimeout(this._timer);
    const reason = addressNumberPauseReason();
    if (reason) {
      this.pause();
      addressNumbersStatus.textContent = reason;
      return;
    }
    this._timer = setTimeout(() => this.refresh(), 400);
  },
  async refresh() {
    if (!this._map || addressNumberPauseReason()) return;
    const bounds = map.getBounds();
    const now = Date.now();
    const cached = [...this._cache.values()].find(item => item.expires > now && item.bounds.contains(bounds));
    if (cached) {
      this._data = cached.data;
      this._limited = cached.limited;
      this.draw();
      return;
    }
    this.pause();
    const ticket = this._ticket;
    const controller = new AbortController();
    this._request = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    addressNumbersStatus.textContent = "Loading nearby address numbers…";
    const queryBounds = bounds.pad(0.1);
    const params = new URLSearchParams({
      f: "json", where: "ADDRESS_TYPE = 1 AND ADDRESS IS NOT NULL",
      geometry: JSON.stringify({ xmin: queryBounds.getWest(), ymin: queryBounds.getSouth(), xmax: queryBounds.getEast(), ymax: queryBounds.getNorth() }),
      geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "4326", outSR: "4326",
      outFields: "OBJECTID,ADDRESS,ADDRESS_FRACTION", returnGeometry: "true",
      resultRecordCount: String(ADDRESS_NUMBER_FETCH_LIMIT), orderByFields: "OBJECTID ASC"
    });
    try {
      const response = await fetch(`${ADDRESS_NUMBER_QUERY}?${params}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Address request failed");
      const result = await response.json();
      if (result.error || !Array.isArray(result.features)) throw new Error("Invalid address response");
      if (!this._map || ticket !== this._ticket || addressNumberPauseReason()) return;
      const data = result.features.slice(0, ADDRESS_NUMBER_FETCH_LIMIT).flatMap(feature => {
        const x = feature.geometry?.x, y = feature.geometry?.y;
        const number = feature.attributes?.ADDRESS;
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90 || number == null) return [];
        const label = [number, feature.attributes.ADDRESS_FRACTION].filter(value => value != null && String(value).trim()).join(" ").slice(0, 24);
        return label ? [{ latlng: L.latLng(y, x), label }] : [];
      });
      const limited = Boolean(result.exceededTransferLimit) || result.features.length >= ADDRESS_NUMBER_FETCH_LIMIT;
      this._cache.set(queryBounds.toBBoxString(), { bounds: queryBounds, data, limited, expires: now + 120000 });
      while (this._cache.size > 6) this._cache.delete(this._cache.keys().next().value);
      this._data = data;
      this._limited = limited;
      this.draw();
    } catch (_) {
      if (this._map && ticket === this._ticket) addressNumbersStatus.textContent = "Address numbers unavailable. Move the map or toggle off/on to retry.";
    } finally {
      clearTimeout(timeout);
      if (this._request === controller) this._request = null;
    }
  },
  draw() {
    if (!this._map || addressNumberPauseReason()) return;
    const canvas = this._canvas;
    const size = map.getSize();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.x * scale);
    canvas.height = Math.round(size.y * scale);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.font = "600 13px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const imagery = aerialBaseMaps.has(activeBaseMap) || activeBaseMap === "dark";
    context.fillStyle = imagery ? "#ffffff" : "#172c42";
    context.strokeStyle = imagery ? "#172c42" : "#ffffff";
    context.lineWidth = 3;
    context.lineJoin = "round";
    const occupied = new Set();
    const limit = window.innerWidth <= 900 ? 120 : 220;
    let count = 0;
    // Draw only viewport labels; grid collision checks avoid hundreds of DOM tooltips.
    const visible = this._data.map(item => ({ ...item, point: map.latLngToContainerPoint(item.latlng) }))
      .filter(item => item.point.x >= 0 && item.point.x <= size.x && item.point.y >= 0 && item.point.y <= size.y)
      .sort((a, b) => a.point.distanceTo(size.divideBy(2)) - b.point.distanceTo(size.divideBy(2)));
    for (const item of visible) {
      if (count >= limit) break;
      const { x, y } = item.point;
      const halfWidth = context.measureText(item.label).width / 2 + 4;
      if (x < halfWidth || x + halfWidth > size.x || y < 12 || y > size.y - 12) continue;
      const cells = [];
      for (let col = Math.floor((x - halfWidth) / 24); col <= Math.floor((x + halfWidth) / 24); col++) {
        for (let row = Math.floor((y - 11) / 24); row <= Math.floor((y + 11) / 24); row++) cells.push(`${col},${row}`);
      }
      if (cells.some(cell => occupied.has(cell))) continue;
      cells.forEach(cell => occupied.add(cell));
      context.strokeText(item.label, x, y);
      context.fillText(item.label, x, y);
      count++;
    }
    canvas.hidden = false;
    canvas.dataset.count = String(count);
    addressNumbersStatus.textContent = count ? `${count} nearby address ${count === 1 ? "number" : "numbers"}.${this._limited || count >= limit ? " Zoom in for more." : ""}`
      : "No city address numbers in this view.";
  }
});
const addressNumbersLayer = new CityAddressNumbers();
function scheduleAddressNumberRefresh() {
  if (!addressNumbersToggle.checked) {
    if (map.hasLayer(addressNumbersLayer)) map.removeLayer(addressNumbersLayer);
    addressNumbersStatus.textContent = addressNumberPauseReason();
  } else if (!map.hasLayer(addressNumbersLayer)) addressNumbersLayer.addTo(map);
  else addressNumbersLayer.schedule();
}
addressNumbersToggle.addEventListener("change", scheduleAddressNumberRefresh);
map.on("draw:drawstart draw:editstart", () => { addressNumbersDrawing = true; scheduleAddressNumberRefresh(); });
map.on("draw:drawstop draw:editstop", () => { addressNumbersDrawing = false; scheduleAddressNumberRefresh(); });
document.getElementById("baseMapSelect").addEventListener("change", scheduleAddressNumberRefresh);

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

const ADDRESS_SEARCH_ALIASES = {
  n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  st: "street", rd: "road", dr: "drive", ave: "avenue", av: "avenue", blvd: "boulevard", ln: "lane", ct: "court",
  cir: "circle", pl: "place", pkwy: "parkway", hwy: "highway", trl: "trail", ter: "terrace"
};

function addressSearchTokens(value) {
  const text = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  return text ? text.split(/\s+/).map(token => ADDRESS_SEARCH_ALIASES[token] || token) : [];
}

function addressSearchData(row) {
  const tokens = addressSearchTokens([row["CSADR#"], row.CSSDIR, row.CSSTRT, row.CSSFUX].filter(value => value != null).join(" "));
  return { tokens, text: tokens.join(" "), houseNumber: addressSearchTokens(row["CSADR#"]).join(" "), bin: binSearchText(row.BINNO) };
}

function binSearchText(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function searchCartQuantity(row) {
  const value = row.QTY;
  if (value == null || !["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : null;
}

function addressSearchScore(data, queryTokens) {
  let score = 0;
  for (const query of queryTokens) {
    const numeric = /^\d/.test(query);
    const tokenScore = Math.max(0, ...data.tokens.map(token => token === query ? 6
      : token.startsWith(query) ? 3 : !numeric && token.includes(query) ? 1 : 0));
    if (!tokenScore) return null;
    score += tokenScore;
  }
  // House numbers match from the start; 123 must not match 9123.
  if (queryTokens.includes(data.houseNumber)) score += 120;
  else if (queryTokens.some(token => /^\d/.test(token) && data.houseNumber.startsWith(token))) score += 30;
  const phrase = queryTokens.join(" ");
  if (data.text === phrase) score += 500;
  else if (data.text.includes(phrase)) score += 15;
  return score;
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
    const status = isDeliveredRow(row)
      ? "Delivered"
      : (dayName(Number(rowDay(row))) || `Day ${rowDay(row) || key.split("|")[1]}`);
    const sequence = rowSequence(row);
    const quantity = multiCartQuantity(row);
    detail.textContent = `Route ${rowRoute(row) || key.split("|")[0]} · ${status}${quantity !== null ? ` · ${quantity} carts` : ""}${sequence !== null ? ` · Seq ${sequence}` : ""} · ${Math.round(distance)} px away`;

    const binNumber = document.createElement("span");
    binNumber.className = "mobile-stop-choice-bin";
    const binValue = String(row.BINNO ?? "").trim();
    binNumber.textContent = `Bin #: ${binValue || "Not provided"}`;

    const selectionState = document.createElement("span");
    selectionState.className = "mobile-stop-choice-state";
    const selected = isStopSelected(marker);
    button.classList.toggle("selected", selected);
    selectionState.textContent = selected ? "Selected · tap to deselect" : "Tap to select";

    const progress = document.createElement("span");
    progress.className = "mobile-stop-choice-detail";
    progress.textContent = cartProgressText(row);
    button.append(address, binNumber, detail, progress, selectionState);
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
  if (optimoLocationPicker) { setOptimoPickPoint(event.latlng); return; }
  if (event.layer) return;
  if (mobileStopSelectionMode && window.innerWidth <= 900) {
    handleMobileStopTap(event.latlng);
  }
});

map.on("popupopen", event => {
  if (optimoLocationPicker || (mobileStopSelectionMode && window.innerWidth <= 900)) {
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
  const isDelivered = isDeliveredRow(marker._rowRef || {});
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
setBaseMap("streets");


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

function multiCartQuantity(row) {
  const value = row.QTY;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 1 ? quantity : null;
}

function cartTotal(row) {
  const quantity = searchCartQuantity(row);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function storedCartCount(row) {
  const total = cartTotal(row);
  const value = row.del_qty;
  if (total === null || !["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= total ? count : null;
}

function isDeliveredRow(row) {
  const count = storedCartCount(row);
  return count !== null ? count === cartTotal(row) : String(row.del_status || "").trim().toLowerCase() === "delivered";
}

function deliveredCartCount(row) {
  return storedCartCount(row) ?? (isDeliveredRow(row) ? cartTotal(row) : 0);
}

function cartProgressText(row) {
  const total = cartTotal(row);
  if (total === null) return "Cart count unavailable (QTY must be a positive whole number)";
  const delivered = deliveredCartCount(row);
  return `${delivered} of ${total} carts delivered · ${total - delivered} remaining`;
}

function matchesCartQuantityFilter(row) {
  return !document.getElementById("multipleCartsOnly").checked || searchCartQuantity(row) >= 2;
}

function setStopVisibility(marker, visible) {
  if (visible && matchesCartQuantityFilter(marker._rowRef)) marker.addTo(map);
  else map.removeLayer(marker);
}

function refreshQuantityBadge(marker) {
  const label = marker._quantityLabel;
  if (!label) return;
  const row = marker._rowRef;
  const total = cartTotal(row);
  label.textContent = total === null ? `×${multiCartQuantity(row)}` : `${deliveredCartCount(row)}/${total}`;
  label.setAttribute("aria-label", cartProgressText(row));
  label.classList.toggle("is-complete", isDeliveredRow(row));
}

function attachQuantityBadge(marker, row) {
  const quantity = multiCartQuantity(row);
  if (quantity === null) return;
  const label = document.createElement("span");
  label.className = "multi-cart-badge";
  label.setAttribute("role", "img");
  marker._quantityLabel = label;
  refreshQuantityBadge(marker);
  const badge = L.marker([marker._base.lat, marker._base.lon], {
    pane: "quantityPane", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "multi-cart-icon", html: label, iconSize: [0, 0], iconAnchor: [-8, 22] })
  });
  marker._quantityBadge = badge;
  // Follow the stop's visibility without adding another selectable stop or tooltip.
  marker.on("add", () => badge.addTo(map));
  marker.on("remove", () => map.removeLayer(badge));
  if (map.hasLayer(marker)) badge.addTo(map);
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

    const show = routes.includes(r) && (layerVisibilityState[key] ?? d !== "Delivered");
    group.layers.forEach(l => setStopVisibility(l, show && days.includes(String(rowDay(l._rowRef)))));
  });

  updateSelectionCount();
  updateUndoButtonState();
  updateStats();
  refreshAddressSearch();
  scheduleSequenceRender();
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
    routeDayGroups[key].layers.forEach(marker => setStopVisibility(marker, checkbox.checked));

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
        setStopVisibility(m, false)
      );
    }
  });

  applyFilters();
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
  applyFilters();
}


// Route/day come from the ROUTE and DAY columns only (NEWROUTE/NEWDAY are ignored).
function rowRoute(row) { return row.ROUTE; }
function rowDay(row) { return row.DAY; }

// Zero is a valid sequence; blank or invalid values must not become zero.
function rowSequence(row, original = false) {
  const value = !original && document.getElementById("sequenceSource").value === "optimo" ? optimoRowSequences.get(row) : row.SEQNO;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// ================= SEQUENCE ARROWS =================
// Original route/day groups are independent of marker filters and delivered-marker groups.
const sequenceGroups = new Map();
const optimoSequenceGroups = new Map();
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
const sequenceNumberPane = map.createPane("sequenceNumberPane");
sequenceNumberPane.style.zIndex = "460";
sequenceNumberPane.style.pointerEvents = "none";
const SequenceNumberLabels = L.Layer.extend({
  onAdd() {
    this._canvas = L.DomUtil.create("canvas", "sequence-number-canvas", sequenceNumberPane);
    this._canvas.setAttribute("aria-hidden", "true");
  },
  onRemove() { L.DomUtil.remove(this._canvas); },
  getEvents() { return { zoomstart: () => { this._canvas.hidden = true; } }; },
  draw(groups) {
    const canvas = this._canvas, size = map.getSize(), scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.x * scale);
    canvas.height = Math.round(size.y * scale);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.font = "700 13px system-ui, sans-serif";
    context.textBaseline = "middle";
    const visibleRows = new Set(Object.values(routeDayGroups).flatMap(group => group.layers.filter(marker => map.hasLayer(marker)).map(marker => marker._rowRef)));
    const occupied = new Set();
    let shown = 0, crowded = 0;
    for (const group of groups) for (const stop of group.stops) {
      if (!stop.latlng || !visibleRows.has(stop.row)) continue;
      const point = map.latLngToContainerPoint(stop.latlng);
      if (point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y) continue;
      const text = `#${stop.seq}`, width = context.measureText(text).width + 12;
      const x = point.x + width + 10 <= size.x ? point.x + 10 : point.x - width - 10;
      const y = point.y + 30 <= size.y ? point.y + 10 : point.y - 30;
      if (x < 0 || y < 0) continue;
      const cells = [];
      for (let col = Math.floor(x / 12); col <= Math.floor((x + width) / 12); col++)
        for (let row = Math.floor(y / 12); row <= Math.floor((y + 20) / 12); row++) cells.push(`${col},${row}`);
      if (cells.some(cell => occupied.has(cell))) { crowded++; continue; }
      cells.forEach(cell => occupied.add(cell));
      context.beginPath();
      context.roundRect(x, y, width, 20, 5);
      context.fillStyle = isDeliveredRow(stop.row) ? "#137442" : "#174a9c";
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = "#ffffff";
      context.stroke();
      context.fillStyle = "#ffffff";
      context.fillText(text, x + 6, y + 10);
      shown++;
    }
    canvas.hidden = false;
    return { shown, crowded };
  }
});
const sequenceNumberLabels = new SequenceNumberLabels();

function scheduleSequenceRender() {
  if (sequenceFrame !== null) return;
  sequenceFrame = requestAnimationFrame(() => { sequenceFrame = null; renderSequenceLayer(); });
}

// Rebuild on file load/reset; retain row references so confirmed saves need only a redraw.
function rebuildSequenceData(rows) {
  resetResequencing();
  sequenceGroups.clear();
  let missing = 0;
  let invalidCoordinates = 0;
  let duplicates = 0;
  rows.forEach((row, index) => {
    const seq = rowSequence(row, true);
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
  restorePhoneSequence(rows);
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

function syncSequenceControls() {
  const usingOptimo = document.getElementById("sequenceSource").value === "optimo";
  const groups = usingOptimo ? optimoSequenceGroups : sequenceGroups;
  const select = document.getElementById("sequenceRouteSelect");
  const available = [...groups.entries()].filter(([, group]) => group.stops.length);
  const signature = JSON.stringify([usingOptimo, available.map(([key, group]) => [key, group.stops.length])]);
  if (select.dataset.options !== signature) {
    const previous = select.value;
    select.replaceChildren(new Option(available.length ? "All routes / days" : "No sequences available", "all"));
    available.forEach(([key, group]) => select.add(new Option(`${group.route} · ${dayName(Number(group.day))} · ${group.stops.length} stops`, key)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    select.dataset.options = signature;
  }
  select.disabled = !available.length;
  document.querySelectorAll("[data-sequence-source]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.sequenceSource === (usingOptimo ? "optimo" : "original")));
  });
  const selectedGroups = available.filter(([key]) => select.value === "all" || select.value === key).map(([, group]) => group);
  const stopCount = selectedGroups.reduce((sum, group) => sum + group.stops.length, 0);
  const drawable = selectedGroups.some(group => group.stops.some((stop, i) => i && stop.latlng && group.stops[i - 1].latlng && !stop.latlng.equals(group.stops[i - 1].latlng)));
  const toggle = document.getElementById("sequenceLayerToggle");
  toggle.disabled = !drawable;
  if (!drawable) toggle.checked = false;
  document.getElementById("sequenceNumbersToggle").disabled = !stopCount;
  return { usingOptimo, stopCount, drawable, selectedGroups };
}

function renderSequenceLayer() {
  const toggle = document.getElementById("sequenceLayerToggle");
  const status = document.getElementById("sequenceLayerStatus");
  const { usingOptimo, stopCount, drawable, selectedGroups } = syncSequenceControls();
  const sourceLabel = usingOptimo ? "Saved Optimo" : "Original file";
  const showNumbers = document.getElementById("sequenceNumbersToggle").checked && stopCount > 0;
  const numberStatus = document.getElementById("sequenceNumbersStatus");
  if (showNumbers) {
    if (!map.hasLayer(sequenceNumberLabels)) sequenceNumberLabels.addTo(map);
    const { shown, crowded } = sequenceNumberLabels.draw(selectedGroups);
    numberStatus.textContent = `${shown} numbers visible.${crowded ? " Zoom in for more; tap overlapping stops for their numbers." : ""}`;
  } else {
    map.removeLayer(sequenceNumberLabels);
    numberStatus.textContent = "";
  }
  document.getElementById("sequenceDisplayBadge").textContent = (toggle.checked && drawable) || showNumbers ? "On map" : "Off";
  if (!toggle.checked || toggle.disabled) {
    map.removeLayer(sequenceLayer);
    sequenceLayer.eachLayer(layer => layer.setLatLngs([]));
    status.textContent = !stopCount
      ? (usingOptimo ? "No saved Optimo sequence. Plan with OptimoRoute, then use the returned sequence on this phone." : "No original sequence available. Open a file with sequence numbers, or plan with OptimoRoute.")
      : !drawable ? `${sourceLabel} · ${stopCount} stops. Arrows need two stops at different locations.`
      : `${sourceLabel} · ${stopCount} stops. Arrows are hidden.`;
    return;
  }
  const pending = [], completed = [], pendingArrows = [], completedArrows = [];
  const badges = [], checks = [];
  const selected = document.getElementById("sequenceRouteSelect").value;
  const delivered = stop => isDeliveredRow(stop.row);
  const bounds = map.getPixelBounds();
  const zoom = map.getZoom();
  let arrowCount = 0;
  (usingOptimo ? optimoSequenceGroups : sequenceGroups).forEach((group, key) => {
    if (selected !== "all" && selected !== key) return;
    const stops = group.stops;
    stops.forEach(stop => {
      if (!stop.latlng || !delivered(stop) || !matchesCartQuantityFilter(stop.row)) return;
      const point = map.project(stop.latlng, zoom);
      if (!bounds.contains(point)) return;
      // Projected offsets keep badges the same screen size at every zoom.
      const at = (x, y) => map.unproject(L.point(point.x + x, point.y + y), zoom);
      badges.push([at(-6, -6), at(6, -6), at(6, 6), at(-6, 6)]);
      checks.push([at(-3, 0), at(-1, 2.5), at(3.5, -3)]);
    });
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1], to = stops[i];
      if (!from.latlng || !to.latlng || from.latlng.equals(to.latlng) || !matchesCartQuantityFilter(from.row) || !matchesCartQuantityFilter(to.row)) continue;
      const done = delivered(from) && delivered(to);
      (done ? completed : pending).push([from.latlng, to.latlng]);
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
  status.textContent = usingOptimo
    ? `Showing Saved Optimo · ${stopCount} stops. ${optimoSequenceCoverage()}`
    : `Showing Original file · ${stopCount} stops. ${sequenceDataNote}`.trim();
}

document.getElementById("sequenceLayerToggle").addEventListener("change", scheduleSequenceRender);
document.getElementById("sequenceNumbersToggle").addEventListener("change", scheduleSequenceRender);
document.getElementById("sequenceRouteSelect").addEventListener("change", () => {
  document.getElementById("sequenceLayerToggle").checked = true;
  scheduleSequenceRender();
});
document.getElementById("sequenceSource").addEventListener("change", () => {
  document.getElementById("sequenceLayerToggle").checked = true;
  refreshAddressSearch();
  map.closePopup();
  scheduleSequenceRender();
});
document.querySelectorAll("[data-sequence-source]").forEach(button => button.addEventListener("click", () => {
  const select = document.getElementById("sequenceSource");
  select.value = button.dataset.sequenceSource;
  select.dispatchEvent(new Event("change"));
}));
map.on("zoomend moveend resize", scheduleSequenceRender);
map.on("layeradd layerremove", event => { if (event.layer._rowRef) scheduleSequenceRender(); });

// ================= PHONE-ONLY OPTIMO RESEQUENCING =================
const OPTIMO_KEY_STORAGE = "cartdelivery.optimo.apiKey";
let optimoRowSequences = new WeakMap();
let resequenceVersion = 0;
let resequenceJob = null;
let phoneSequenceKey = null;
let phoneSequenceRows = null;
let optimoRequestController = null;
const resequenceElement = id => document.getElementById(id);
const sequenceGroupKey = row => JSON.stringify([String(rowRoute(row) ?? "").trim(), String(rowDay(row) ?? "").trim()]);
const optimoMapLocations = { start: null, end: null };
const optimoEndpointMarkers = L.layerGroup().addTo(map);

function validOptimoLocation(location) {
  return location?.type === "custom" && Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180;
}

function optimoLocationMarker(kind, latlng, draggable = false) {
  const label = document.createElement("span");
  label.className = `optimo-location-pin ${kind}`;
  label.textContent = kind === "start" ? "Start" : "End";
  return L.marker(latlng, { interactive: draggable, keyboard: draggable, draggable,
    title: `${kind === "start" ? "Start" : "End"} location${draggable ? " — drag to adjust" : ""}`, zIndexOffset: 1000,
    icon: L.divIcon({ className: `optimo-location-icon ${kind}`, html: label, iconSize: [64, 56], iconAnchor: [32, 56] }) });
}

function setOptimoPickPoint(latlng) {
  const picker = optimoLocationPicker;
  if (!picker || !latlng) return;
  const point = L.latLng(latlng).wrap();
  if (!validOptimoLocation({ type: "custom", latitude: point.lat, longitude: point.lng })) return;
  if (picker.marker) picker.marker.setLatLng(point);
  else {
    picker.marker = optimoLocationMarker(picker.kind, point, true).addTo(map);
    picker.marker.on("dragend", () => setOptimoPickPoint(picker.marker.getLatLng()));
  }
  resequenceElement("optimoLocationPickerHelp").textContent = "Pin placed. Drag it or tap another spot to adjust.";
  resequenceElement("useOptimoLocation").disabled = false;
}

function refreshOptimoLocations() {
  optimoEndpointMarkers.clearLayers();
  for (const kind of ["start", "end"]) {
    const location = optimoMapLocations[kind];
    const mode = resequenceElement(kind === "start" ? "optimoStart" : "optimoEnd").value;
    resequenceElement(`optimo${kind === "start" ? "Start" : "End"}Point`).textContent = mode === "map"
      ? validOptimoLocation(location) ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` : "Choose a point on the map before generating."
      : "";
    if (mode === "map" && validOptimoLocation(location))
      optimoLocationMarker(kind, [location.latitude, location.longitude]).addTo(optimoEndpointMarkers);
  }
}

function beginOptimoLocationPick(kind) {
  if (resequenceBusy || deliverySaveInProgress || optimoLocationPicker) return;
  if (Object.values(drawControl._toolbars).some(toolbar => toolbar.enabled())) {
    setResequenceStatus("Finish or cancel editing your selection shape before choosing a location.");
    return;
  }
  const center = map.getCenter(), zoom = map.getZoom();
  resequenceElement("resequenceDialog").close();
  closeMobileMenu();
  map.closePopup();
  resequenceElement("mobileStopPicker").hidden = true;
  optimoLocationPicker = { kind, center, zoom };
  map.stop();
  document.body.classList.add("picking-optimo-location");
  resequenceElement("optimoLocationPicker").hidden = false;
  resequenceElement("optimoLocationPicker").dataset.kind = kind;
  resequenceElement("optimoLocationPickerTitle").textContent = `Choose ${kind} location`;
  resequenceElement("optimoLocationPickerHelp").textContent = `Tap the map to place your ${kind} pin. Zoom in for accuracy.`;
  resequenceElement("useOptimoLocation").textContent = `Confirm ${kind}`;
  resequenceElement("useOptimoLocation").disabled = true;
  optimoEndpointMarkers.clearLayers();
  const other = kind === "start" ? "end" : "start", otherPoint = optimoMapLocations[other];
  if (validOptimoLocation(otherPoint) && resequenceElement(other === "start" ? "optimoStart" : "optimoEnd").value === "map")
    optimoLocationMarker(other, [otherPoint.latitude, otherPoint.longitude]).addTo(optimoEndpointMarkers);
  map.invalidateSize({ pan: false });
  map.setView(center, zoom, { animate: false });
  const previous = optimoMapLocations[kind];
  if (validOptimoLocation(previous)) {
    map.setView([previous.latitude, previous.longitude], zoom, { animate: false });
    setOptimoPickPoint([previous.latitude, previous.longitude]);
  }
  resequenceElement("optimoLocationPickerTitle").focus({ preventScroll: true });
}

function finishOptimoLocationPick(useLocation, reopen = true) {
  const picker = optimoLocationPicker;
  if (!picker) return;
  if (useLocation) {
    if (!picker.marker) return;
    const point = picker.marker.getLatLng().wrap();
    const location = { type: "custom", latitude: point.lat, longitude: point.lng };
    if (!validOptimoLocation(location)) return;
    optimoMapLocations[picker.kind] = location;
    const select = resequenceElement(picker.kind === "start" ? "optimoStart" : "optimoEnd");
    select.value = "map";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (picker.marker) map.removeLayer(picker.marker);
  optimoLocationPicker = null;
  document.body.classList.remove("picking-optimo-location");
  resequenceElement("optimoLocationPicker").hidden = true;
  map.invalidateSize({ pan: false });
  map.setView(picker.center, picker.zoom, { animate: false });
  refreshOptimoLocations();
  updateSelectionCount();
  updateUndoButtonState();
  if (reopen) {
    refreshResequenceScope();
    resequenceElement("resequenceDialog").showModal();
    resequenceElement(picker.kind === "start" ? "pickOptimoStart" : "pickOptimoEnd").focus({ preventScroll: true });
  }
}

resequenceElement("centerOptimoLocation").addEventListener("click", () => setOptimoPickPoint(map.getCenter()));
resequenceElement("pickOptimoStart").addEventListener("click", () => beginOptimoLocationPick("start"));
resequenceElement("pickOptimoEnd").addEventListener("click", () => beginOptimoLocationPick("end"));
resequenceElement("useOptimoLocation").addEventListener("click", () => finishOptimoLocationPick(true));
resequenceElement("cancelOptimoLocation").addEventListener("click", () => finishOptimoLocationPick(false));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && optimoLocationPicker) { event.preventDefault(); finishOptimoLocationPick(false); }
});

function setResequenceStatus(message) { resequenceElement("resequenceStatus").textContent = message; }

function setResequenceBusy(busy) {
  resequenceBusy = busy;
  resequenceElement("resequenceSettings").disabled = busy;
  ["generateSequenceBtn", "resumeSequenceBtn", "saveSequenceBtn"].forEach(id => { resequenceElement(id).disabled = busy; });
  resequenceElement("resequenceDialog").setAttribute("aria-busy", String(busy));
  updateDeliveryButtons();
}

function resetResequencing() {
  finishOptimoLocationPick(false, false);
  optimoMapLocations.start = optimoMapLocations.end = null;
  resequenceElement("optimoStart").value = "gps";
  resequenceElement("optimoEnd").value = "depot";
  refreshOptimoLocations();
  resequenceVersion++;
  optimoRequestController?.abort();
  resequenceJob = null;
  phoneSequenceKey = null;
  phoneSequenceRows = null;
  optimoSequenceGroups.clear();
  optimoRowSequences = new WeakMap();
  resequenceElement("sequenceSource").value = "original";
  resequenceElement("sequenceRouteSelect").dataset.options = "";
  resequenceElement("sequenceSource").options[1].disabled = false;
  ["resumeSequenceBtn", "saveSequenceBtn", "resequencePreview"].forEach(id => { resequenceElement(id).hidden = true; });
  resequenceElement("resequenceDialog").close();
  resequenceElement("optimoScope").replaceChildren(new Option("All route/day groups", ""));
  setResequenceBusy(false);
  setResequenceStatus("");
}

function selectedVisibleSequenceRows(inView = true) {
  const selected = new Set(), tester = createSelectionTester(), bounds = map.getBounds();
  Object.values(routeDayGroups).forEach(group => group.layers.forEach(marker => {
    const row = marker._rowRef;
    if (!row || isDeliveredRow(row) || !isStopSelected(marker, tester)) return;
    const base = marker._base;
    const location = base ? L.latLng(base.lat, base.lon) : getLayerLatLng(marker);
    if (location && (!inView || bounds.contains(location))) selected.add(row);
  }));
  return selected;
}

function remainingSequenceGroups(rows, scope = "", validate = true) {
  const groups = new Map();
  const selected = ["selected", "selectedAll"].includes(scope) ? selectedVisibleSequenceRows(scope === "selected") : null;
  rows.forEach((row, index) => {
    if (isDeliveredRow(row)) return;
    if (selected ? !selected.has(row) : scope && sequenceGroupKey(row) !== scope) return;
    const route = String(rowRoute(row) ?? "").trim(), day = String(rowDay(row) ?? "").trim();
    const lat = Number(row.LATITUDE), lng = Number(row.LONGITUDE);
    if (validate && (!route || !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 7))
      throw new Error(`Spreadsheet row ${index + 2} needs a valid ROUTE and DAY (1–7). No records were sent.`);
    if (validate && (!String(row.LATITUDE ?? "").trim() || !String(row.LONGITUDE ?? "").trim() ||
        !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180))
      throw new Error(`Spreadsheet row ${index + 2} needs valid coordinates. No records were sent.`);
    const key = sequenceGroupKey(row);
    if (!groups.has(key)) groups.set(key, { key, route, day, indices: [] });
    groups.get(key).indices.push(index);
  });
  return [...groups.values()];
}

async function phoneSequenceStorageKey(rows) {
  // Delivery saves/undo must not invalidate the phone's order.
  const identity = rows.map(row => Object.keys(row).filter(key => !["del_status", "del_qty"].includes(key)).sort().map(key => [key, row[key]]));
  const bytes = new TextEncoder().encode(JSON.stringify([window._currentFilePath || "", identity]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "cartdelivery.optimo.sequence." + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
}

function applyPhoneSequence(rows, saved) {
  if (saved?.version !== 2 || !Array.isArray(saved.groups)) throw new Error("Regenerate this sequence to load currently scheduled OptimoRoute records.");
  const groups = new Map(), seen = new Set(), order = new WeakMap();
  saved.groups.forEach(group => {
    const key = JSON.stringify([group.route, group.day]);
    if (!Array.isArray(group.indices) || !Array.isArray(group.sequences) || group.sequences.length !== group.indices.length || groups.has(key)) throw new Error("Invalid saved sequence.");
    const stops = group.indices.map((index, i) => {
      if (!Number.isInteger(index) || !rows[index] || seen.has(index) || sequenceGroupKey(rows[index]) !== key)
        throw new Error("The saved sequence does not match this file.");
      seen.add(index);
      const row = rows[index];
      const seq = group.sequences[i];
      if (!Number.isInteger(seq) || seq < 1 || (i && seq <= group.sequences[i - 1])) throw new Error("Invalid saved stop order.");
      order.set(row, seq);
      return { row, seq, index, latlng: L.latLng(Number(row.LATITUDE), Number(row.LONGITUDE)) };
    });
    groups.set(key, { route: group.route, day: group.day, driver: group.driver, stops });
  });
  optimoSequenceGroups.clear();
  groups.forEach((group, key) => optimoSequenceGroups.set(key, group));
  optimoRowSequences = order;
  const select = resequenceElement("sequenceRouteSelect");
  groups.forEach((group, key) => {
    if (![...select.options].some(option => option.value === key))
      select.add(new Option(`Route ${group.route} · ${dayName(Number(group.day))}`, key));
  });
  resequenceElement("sequenceSource").options[1].disabled = false;
  resequenceElement("sequenceSource").value = "optimo";
  resequenceElement("sequenceLayerToggle").disabled = false;
  resequenceElement("sequenceLayerToggle").checked = true;
  scheduleSequenceRender();
  refreshAddressSearch();
  map.closePopup();
  updateSelectionCount();
  updateUndoButtonState();
}

async function restorePhoneSequence(rows) {
  if (!rows.length) return;
  const version = resequenceVersion;
  try {
    const key = await phoneSequenceStorageKey(rows);
    if (version !== resequenceVersion) return;
    phoneSequenceKey = key;
    phoneSequenceRows = rows;
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      applyPhoneSequence(rows, parsed.version === 2 ? parsed : { version: 2, groups: [] });
      if (parsed.version !== 2) setResequenceStatus("Previous joined sequence hidden. Generate again to load currently scheduled OptimoRoute records.");
    }
  } catch {
    if (version === resequenceVersion) setResequenceStatus("This browser could not restore its saved sequence. You can generate another.");
  }
}

function optimoSequenceCoverage() {
  const scope = resequenceElement("sequenceRouteSelect").value;
  const missing = (window._currentRows || []).filter(row => !isDeliveredRow(row) &&
    (scope === "all" || sequenceGroupKey(row) === scope) && !optimoRowSequences.has(row)).length;
  return missing ? `${missing} pending records have no Optimo sequence number or arrows.` : "All remaining records have an Optimo sequence.";
}

function validOptimoDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function refreshResequenceScope() {
  const scope = resequenceElement("optimoScope").value;
  const rows = window._currentRows || [];
  const pending = rows.filter(row => !isDeliveredRow(row));
  const groups = resequenceJob?.scope === scope ? resequenceJob.groups : remainingSequenceGroups(rows, scope, false);
  const selected = groups.reduce((sum, group) => sum + group.indices.length, 0);
  const activeGroups = new Map(groups.map(group => [group.key, group]));
  resequenceElement("resequenceSummary").textContent = `${selected.toLocaleString()} undelivered records selected${scope === "selected" ? " from the visible map selection" : scope === "selectedAll" ? " from your map selection" : ""} · ${pending.length.toLocaleString()} remaining in ${window._currentFilePath || "this file"}.`;
  resequenceElement("optimoScopeHelp").textContent = scope === "selected"
    ? "Only selected, undelivered stops in the current map view are included. Hidden layers and off-screen stops are excluded. The selection is captured when you press Generate. All other records will have no Optimo number or arrow."
    : scope === "selectedAll" ? "Only selected, undelivered stops on visible layers are included, even if off-screen. Unselected stops will have no Optimo number or arrow."
    : "Includes all undelivered records in the chosen route/day groups, including hidden and off-screen stops.";
  resequenceElement("optimoDrivers").querySelectorAll("input").forEach(input => {
    const group = activeGroups.get(input.dataset.group);
    input.hidden = !group;
    input.disabled = input.hidden;
    const label = document.querySelector(`label[for="${input.id}"]`);
    label.hidden = input.hidden;
    if (group) label.textContent = `${group.route} · ${dayName(Number(group.day))}: driver external ID (${group.indices.length} records)`;
  });
  const date = resequenceElement("optimoDate").value;
  resequenceElement("optimoClearDateNotice").textContent = validOptimoDate(date)
    ? `Before uploading, this will delete ALL OptimoRoute orders and planned routes on ${date} in the account linked to this key, including other route/day groups. Other dates are unchanged.`
    : "Choose a valid planning date. That date's OptimoRoute orders and planned routes will be cleared before uploading.";
}

function openResequencing() {
  const rows = window._currentRows;
  if (!rows?.length || !Object.keys(routeDayGroups).length) { alert("Open a route file first."); return; }
  const pending = rows.filter(row => !isDeliveredRow(row)).length;
  const changedSelection = ["selected", "selectedAll"].includes(resequenceJob?.scope) &&
    JSON.stringify(remainingSequenceGroups(rows, resequenceJob.scope, false).map(group => group.indices)) !== JSON.stringify(resequenceJob.groups.map(group => group.indices));
  if (!resequenceBusy && resequenceJob && (changedSelection || resequenceJob.pending !== rows.map(row => isDeliveredRow(row) ? "1" : "0").join(""))) {
    resequenceJob = null;
    ["saveSequenceBtn", "resumeSequenceBtn", "resequencePreview"].forEach(id => { resequenceElement(id).hidden = true; });
  }
  resequenceElement("resequenceSummary").textContent = `${pending.toLocaleString()} remaining records in ${window._currentFilePath || "this file"}.`;
  if (!resequenceBusy && !resequenceJob) {
    const date = new Date();
    resequenceElement("optimoDate").value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    try { resequenceElement("optimoKey").value = localStorage.getItem(OPTIMO_KEY_STORAGE) || ""; } catch { /* Session entry still works. */ }
    const drivers = resequenceElement("optimoDrivers");
    const previousDrivers = new Map([...drivers.querySelectorAll("input")].map(input => [input.dataset.group, input.value]));
    drivers.replaceChildren();
    const scope = resequenceElement("optimoScope"), previousScope = scope.value;
    scope.replaceChildren(new Option("All route/day groups", ""), new Option("Selected stops", "selectedAll"), new Option("Selected visible stops", "selected"));
    try {
      remainingSequenceGroups(rows, "", false).forEach((group, i) => {
        scope.add(new Option(`${group.route || "Missing route"} · ${dayName(Number(group.day)) || "Invalid day"} (${group.indices.length} undelivered)`, group.key));
        const label = document.createElement("label"), input = document.createElement("input");
        input.id = `optimoDriver${i}`;
        input.dataset.group = group.key;
        input.value = previousDrivers.get(group.key) || `CART-${group.route.replace(/[^a-z0-9_-]/gi, "-")}-${group.day}`;
        input.autocomplete = "off";
        input.setAttribute("autocapitalize", "none");
        label.htmlFor = input.id;
        label.textContent = `${group.route} · ${dayName(Number(group.day))}: driver external ID (${group.indices.length} records)`;
        drivers.append(label, input);
      });
      if ([...scope.options].some(option => option.value === previousScope)) scope.value = previousScope;
      setResequenceStatus(pending ? "Ready. Each route/day needs its own driver in OptimoRoute." : "All records are already delivered.");
    } catch (error) { setResequenceStatus(error.message); }
  }
  refreshResequenceScope();
  refreshOptimoLocations();
  resequenceElement("resequenceDialog").showModal();
}

function assertResequenceCurrent(job) {
  if (job.version !== resequenceVersion || job.rows !== window._currentRows || job.filePath !== window._currentFilePath)
    throw new Error("The open file changed. Generate again for the current file.");
  if (job.pending !== job.rows.map(row => isDeliveredRow(row) ? "1" : "0").join(""))
    throw new Error("Delivery status changed. Generate again to include exactly the remaining records.");
}

async function optimoRequest(job, endpoint, body, params = {}) {
  assertResequenceCurrent(job);
  // OptimoRoute deletes every date if date is omitted; never allow that request.
  if (endpoint === "delete_all_orders" && (!validOptimoDate(body?.date) || body.date !== job.date))
    throw new Error("A valid matching planning date is required before clearing OptimoRoute orders.");
  const url = new URL(`https://api.optimoroute.com/v1/${endpoint}`);
  url.search = new URLSearchParams({ key: job.apiKey, ...params });
  const controller = new AbortController();
  optimoRequestController = controller;
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal
    });
    if (!response.ok) throw new Error(`OptimoRoute returned HTTP ${response.status}.`);
    const data = await response.json();
    if (data.success !== true) {
      if (data.code === "ERR_OPT_REQUESTS_EXCEEDED") {
        const count = body?.useOrderObjects?.length || job.groups.reduce((total, group) => total + group.indices.length, 0);
        throw new Error(`OptimoRoute rejected planning ${count.toLocaleString()} orders because its planning order limit was exceeded (ERR_OPT_REQUESTS_EXCEEDED). Uploading in batches of 500 does not change that limit. Ask OptimoRoute to raise your account's limit to plan all selected records together. Smaller sections leave only the last section scheduled per driver. No sequence displayed.`);
      }
      const code = /^ERR_[A-Z0-9_]+$/.test(data.code || "") ? ` (${data.code})` : "";
      throw new Error(`OptimoRoute could not complete ${endpoint.replaceAll("_", " ")}${code}. Check your key, account limits, and driver setup.`);
    }
    assertResequenceCurrent(job);
    return data;
  } catch (error) {
    if (error instanceof TypeError || error.name === "AbortError")
      throw new Error("OptimoRoute did not respond. Check your connection. A submitted request may still have completed in OptimoRoute.");
    throw error;
  } finally {
    clearTimeout(timer);
    if (optimoRequestController === controller) optimoRequestController = null;
  }
}

function optimoOrders(job) {
  return job.groups.flatMap(group => group.indices.map(index => {
    const row = job.rows[index], orderNo = `${job.run}-${index}`;
    const address = [row["CSADR#"], row.CSSDIR, row.CSSTRT, row.CSSFUX, row.CSCITY, row.CSSTAT, row.CSZIP5]
      .filter(value => value != null && String(value).trim()).join(" ");
    return {
      operation: "CREATE", orderNo, date: job.date, type: "T", duration: 0,
      assignedTo: { externalId: group.driver }, notificationPreference: "dont_notify",
      load1: 0, load2: 0, load3: 0, load4: 0,
      timeWindows: [], skills: [], vehicleFeatures: [],
      location: { locationNo: orderNo, address: address || `Cart record ${index + 2}`,
        latitude: Number(row.LATITUDE), longitude: Number(row.LONGITUDE), checkInTime: 0 }
    };
  }));
}

function optimoPlanningSections(rows, groups, size) {
  if (!size) return [{ groups }];
  return groups.flatMap(group => {
    const indices = group.indices.slice().sort((a, b) =>
      (rowSequence(rows[a], true) ?? Infinity) - (rowSequence(rows[b], true) ?? Infinity) || a - b);
    const sections = [];
    for (let offset = 0; offset < indices.length; offset += size)
      sections.push({ groups: [{ ...group, indices: indices.slice(offset, offset + size) }] });
    return sections;
  });
}

function nextOptimoSection(job) {
  const driver = job.sections[0].groups[0].driver;
  const start = job.ends.get(driver) || job.startLocation;
  let next = 0;
  if (job.sectionSize && start) {
    let nearest = Infinity;
    const anchor = L.latLng(start.latitude, start.longitude);
    job.sections.forEach((section, index) => {
      if (section.groups[0].driver !== driver) return;
      const distance = Math.min(...section.groups[0].indices.map(i =>
        anchor.distanceTo(L.latLng(Number(job.rows[i].LATITUDE), Number(job.rows[i].LONGITUDE)))));
      if (distance < nearest) { nearest = distance; next = index; }
    });
  }
  return job.sections.splice(next, 1)[0];
}

async function startOptimoSection(job) {
  if (!job.dateCleared) throw new Error("The planning date has not been cleared. No records were uploaded.");
  const groups = job.section.groups;
  const label = `section ${job.completedSections + 1} of ${job.sectionCount}`;
  const updates = groups.map(group => ({ driver: { externalId: group.driver }, date: job.date, enabled: true,
    workTime: { from: "00:00", to: "23:59" },
    startLocation: job.ends.get(group.driver) || job.startLocation || { type: "employeeDefault" },
    endLocation: job.endLocation }));
  setResequenceStatus(`Setting all-day hours and start locations · ${label}…`);
  const result = await optimoRequest(job, "update_drivers_parameters", { updates });
  if (!Array.isArray(result.updates) || result.updates.length !== groups.length || result.updates.some(update => update.success !== true))
    throw new Error("Driver hours or starts could not be updated. Verify every driver external ID in OptimoRoute. No orders for this section were sent.");
  const orders = optimoOrders({ ...job, groups });
  for (let offset = 0; offset < orders.length; offset += 500) {
    const batch = orders.slice(offset, offset + 500);
    setResequenceStatus(`Sending ${label} · ${offset} / ${orders.length} records…`);
    job.ordersMayExist = true;
    const response = await optimoRequest(job, "create_or_update_orders", { orders: batch });
    const accepted = new Map((response.orders || []).map(order => [order.orderNo, order]));
    if (accepted.size !== batch.length || batch.some(order => accepted.get(order.orderNo)?.success !== true))
      throw new Error("Some records were rejected by OptimoRoute. Planning was not started for this section. Check driver setup and account limits. No sequence displayed.");
  }
  setResequenceStatus(`Starting OptimoRoute planning · ${label}…`);
  const planning = await optimoRequest(job, "start_planning", { date: job.date, balancing: "OFF", startWith: "EMPTY", depotTrips: false,
    useDrivers: groups.map(group => ({ driverExternalId: group.driver })),
    useOrderObjects: orders.map(order => ({ orderNo: order.orderNo })), includeScheduledOrders: false });
  if (!Number.isInteger(planning.planningId)) throw new Error("OptimoRoute did not return a planning ID. Check the plan in OptimoRoute before generating again.");
  job.planningId = planning.planningId;
  resequenceElement("resumeSequenceBtn").hidden = false;
}

function matchOptimoSequence(job, routes) {
  if (!Array.isArray(routes)) throw new Error("OptimoRoute returned no routes.");
  const seen = new Set();
  const groups = job.groups.map(group => {
    const expected = new Map(group.indices.map(index => [`${job.run}-${index}`, index]));
    const matches = routes.filter(route => route.driverExternalId === group.driver);
    if (matches.length > 1) throw new Error(`Expected at most one route for ${group.route} / day ${group.day}; received ${matches.length}. No sequence displayed.`);
    if (matches.length && !Array.isArray(matches[0].stops)) throw new Error("OptimoRoute returned an invalid stop list.");
    const sequenceNumbers = new Set();
    const indices = (matches[0]?.stops || []).filter(stop => !["break", "depot"].includes(stop.type)).slice().sort((a, b) => a.stopNumber - b.stopNumber).map(stop => {
      const index = expected.get(stop.orderNo);
      if (index === undefined || seen.has(index) || !Number.isInteger(stop.stopNumber) || stop.stopNumber < 1 || sequenceNumbers.has(stop.stopNumber))
        throw new Error("OptimoRoute returned duplicate, unexpected, or invalid stops. No sequence displayed.");
      seen.add(index);
      sequenceNumbers.add(stop.stopNumber);
      return index;
    });
    return { route: group.route, day: group.day, driver: group.driver, indices, sequences: [...sequenceNumbers] };
  });
  return { version: 2, date: job.date, createdAt: new Date().toISOString(), groups };
}

async function readOptimoPlanning(job) {
  while (job.section || job.sections.length) {
    assertResequenceCurrent(job);
    if (!job.section) {
      job.section = nextOptimoSection(job);
      await startOptimoSection(job);
    }
    if (!await readOptimoSection(job)) return;
    job.section = null;
    job.planningId = null;
    job.completedSections++;
    resequenceElement("resumeSequenceBtn").hidden = true;
  }
  // Earlier sections may now be unscheduled. Only the final server routes are authoritative.
  const routes = [];
  for (const group of job.groups) {
    const response = await optimoRequest(job, "get_routes", null, { date: job.date, driverExternalId: group.driver });
    if (!Array.isArray(response.routes)) throw new Error("OptimoRoute returned no route list. No sequence displayed.");
    routes.push(...response.routes);
  }
  job.result = { ...matchOptimoSequence(job, routes), sectionCount: job.sectionCount };
  const list = resequenceElement("resequencePreviewList");
  list.replaceChildren();
  job.result.groups.forEach(group => {
    const item = document.createElement("li"), sample = document.createElement("p");
    const requested = job.groups.find(input => input.driver === group.driver).indices.length;
    item.textContent = `${group.route} · ${dayName(Number(group.day))}: ${group.indices.length} scheduled / ${requested} selected · ${requested - group.indices.length} unscheduled`;
    sample.textContent = group.indices.slice(0, 3).map((index, i) => {
      const row = job.rows[index];
      return `${group.sequences[i]}. ${[row["CSADR#"], row.CSSDIR, row.CSSTRT, row.CSSFUX].filter(Boolean).join(" ") || `Row ${index + 2}`} (Bin ${row.BINNO ?? "—"})`;
    }).join(" → ");
    item.append(sample);
    list.append(item);
  });
  resequenceElement("resequencePreviewMore").textContent = "First three records shown for each route/day. The full order will appear in sequence arrows and stop details.";
  resequenceElement("resequencePreview").hidden = false;
  resequenceElement("saveSequenceBtn").hidden = false;
  const selected = job.groups.reduce((sum, group) => sum + group.indices.length, 0);
  const scheduled = job.result.groups.reduce((sum, group) => sum + group.indices.length, 0);
  setResequenceStatus(`${scheduled === selected ? "Complete" : "Partial plan"}: ${scheduled.toLocaleString()} scheduled / ${selected.toLocaleString()} selected · ${(selected - scheduled).toLocaleString()} unscheduled. Only scheduled records will have sequence numbers and arrows. Snapshot read from OptimoRoute for ${job.date}.${job.sectionSize ? " Earlier sections replaced by later plans are excluded." : ""}`);
}

async function readOptimoSection(job) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const progress = await optimoRequest(job, "get_planning_status", null, { planningId: job.planningId });
    if (progress.status === "F") {
      const routes = [];
      for (const group of job.section.groups) {
        const result = await optimoRequest(job, "get_routes", null, { date: job.date, driverExternalId: group.driver });
        if (!Array.isArray(result.routes)) throw new Error("OptimoRoute returned no routes.");
        routes.push(...result.routes);
      }
      const result = matchOptimoSequence({ ...job, groups: job.section.groups }, routes);
      result.groups.forEach(group => {
        const last = job.rows[group.indices[group.indices.length - 1]];
        if (last) job.ends.set(group.driver, { type: "custom", latitude: Number(last.LATITUDE), longitude: Number(last.LONGITUDE) });
      });
      return true;
    }
    if (!["N", "R"].includes(progress.status)) throw new Error("OptimoRoute planning stopped or failed. No sequence displayed.");
    setResequenceStatus(`OptimoRoute is planning section ${job.completedSections + 1} of ${job.sectionCount}${Number.isFinite(progress.percentageComplete) ? ` · ${progress.percentageComplete}%` : ""}. Keep this page open until all sections finish.`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  setResequenceStatus(`Section ${job.completedSections + 1} of ${job.sectionCount} is still running. Tap Check planning result to continue. Optimo numbers and arrows stay hidden until a result is saved.`);
  return false;
}

async function generateOptimoSequence() {
  if (resequenceBusy || deliverySaveInProgress) return;
  const version = resequenceVersion;
  setResequenceBusy(true);
  try {
    const scope = resequenceElement("optimoScope").value;
    const rows = window._currentRows, groups = remainingSequenceGroups(rows || [], scope);
    if (!groups.length) throw new Error(["selected", "selectedAll"].includes(scope)
      ? "No selected, visible undelivered stops. Close this dialog, select stops on the map, and try again. No OptimoRoute orders were deleted."
      : "No undelivered records to resequence.");
    const apiKey = resequenceElement("optimoKey").value.trim(), date = resequenceElement("optimoDate").value;
    if (!apiKey) throw new Error("Enter your OptimoRoute API key on this phone.");
    if (!validOptimoDate(date)) throw new Error("Choose a valid planning date. No OptimoRoute orders were deleted.");
    const sectionSize = Number(resequenceElement("optimoSectionSize").value);
    if (![0, 100, 500].includes(sectionSize)) throw new Error("Choose a planning size.");
    const startMode = resequenceElement("optimoStart").value, endMode = resequenceElement("optimoEnd").value;
    if (startMode === "map" && !validOptimoLocation(optimoMapLocations.start)) throw new Error("Choose a start location on the map. No OptimoRoute orders were deleted.");
    if (endMode === "map" && !validOptimoLocation(optimoMapLocations.end)) throw new Error("Choose an end location on the map. No OptimoRoute orders were deleted.");
    const endLocation = endMode === "map" ? { ...optimoMapLocations.end } : { type: endMode === "start" ? "startLocation" : "employeeDefault" };
    const inputs = [...resequenceElement("optimoDrivers").querySelectorAll("input")];
    groups.forEach(group => { group.driver = inputs.find(input => input.dataset.group === group.key)?.value.trim(); });
    if (groups.some(group => !group.driver) || new Set(groups.map(group => group.driver)).size !== groups.length)
      throw new Error("Enter a different dedicated driver external ID for each route/day.");
    try {
      if (resequenceElement("rememberOptimoKey").checked) localStorage.setItem(OPTIMO_KEY_STORAGE, apiKey);
      else localStorage.removeItem(OPTIMO_KEY_STORAGE);
    } catch {
      if (resequenceElement("rememberOptimoKey").checked) throw new Error("Browser storage is unavailable. Turn off Remember key to use it for this session.");
    }
    const storageKey = phoneSequenceRows === rows && phoneSequenceKey ? phoneSequenceKey : await phoneSequenceStorageKey(rows);
    if (version !== resequenceVersion) return;
    const sections = optimoPlanningSections(rows, groups, sectionSize);
    const job = { version, rows, filePath: window._currentFilePath, storageKey, groups, apiKey, date, scope, sectionSize, sections, endLocation,
      sectionCount: sections.length, completedSections: 0, ends: new Map(),
      run: `CD-${crypto.randomUUID()}`, pending: rows.map(row => isDeliveredRow(row) ? "1" : "0").join("") };
    resequenceJob = job;
    refreshResequenceScope();
    ["saveSequenceBtn", "resumeSequenceBtn", "resequencePreview"].forEach(id => { resequenceElement(id).hidden = true; });
    let startLocation = startMode === "map" ? { ...optimoMapLocations.start } : undefined;
    if (startMode === "gps") {
      setResequenceStatus("Getting your current GPS location…");
      if (!navigator.geolocation) throw new Error("GPS is unavailable. Enable location access or choose the driver's configured start.");
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
        () => reject(new Error("Could not get your location. Enable location access or choose the driver's configured start.")),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
      assertResequenceCurrent(job);
      startLocation = { type: "custom", latitude: position.coords.latitude, longitude: position.coords.longitude };
    }
    job.startLocation = startLocation;
    // Date clearing invalidates every previous group, even when planning only one group.
    const empty = { version: 2, date, createdAt: new Date().toISOString(), groups: [] };
    localStorage.setItem(storageKey, JSON.stringify(empty));
    applyPhoneSequence(rows, empty);
    setResequenceStatus(`Clearing all OptimoRoute orders and planned routes on ${date}…`);
    try {
      await optimoRequest(job, "delete_all_orders", { date });
    } catch (error) {
      throw new Error(`Could not confirm that ${date} was cleared. No new records were uploaded. ${error.message}`);
    }
    job.dateCleared = true;
    await readOptimoPlanning(job);
  } catch (error) {
    if (version === resequenceVersion) setResequenceStatus(`${error.message}${resequenceJob?.ordersMayExist ? " Orders already sent remain in OptimoRoute with a CD- prefix." : ""}`);
  } finally {
    if (version === resequenceVersion) setResequenceBusy(false);
  }
}

resequenceElement("openResequenceBtn").addEventListener("click", openResequencing);
resequenceElement("closeResequenceBtn").addEventListener("click", () => resequenceElement("resequenceDialog").close());
resequenceElement("forgetOptimoKey").addEventListener("click", () => {
  try {
    localStorage.removeItem(OPTIMO_KEY_STORAGE);
    resequenceElement("optimoKey").value = "";
    resequenceElement("rememberOptimoKey").checked = false;
    if (resequenceJob) resequenceJob.apiKey = "";
    setResequenceStatus("API key forgotten on this phone.");
  } catch { setResequenceStatus("Browser storage could not be cleared. Clear this site's data in your browser settings."); }
});
resequenceElement("generateSequenceBtn").addEventListener("click", generateOptimoSequence);
resequenceElement("resequenceSettings").addEventListener("change", event => {
  if (["optimoKey", "rememberOptimoKey"].includes(event.target.id) || resequenceBusy) return;
  resequenceJob = null;
  refreshOptimoLocations();
  refreshResequenceScope();
  ["saveSequenceBtn", "resumeSequenceBtn", "resequencePreview"].forEach(id => { resequenceElement(id).hidden = true; });
  setResequenceStatus("Settings changed. Generate a new plan to use these settings.");
});
resequenceElement("resumeSequenceBtn").addEventListener("click", async () => {
  if (resequenceBusy || deliverySaveInProgress || !resequenceJob?.planningId) return;
  const job = resequenceJob;
  setResequenceBusy(true);
  try {
    const apiKey = resequenceElement("optimoKey").value.trim();
    if (!apiKey) throw new Error("Enter your API key to check the result.");
    if (apiKey !== job.apiKey) throw new Error("Use the same API key to continue. To change accounts or recover after Forget key, start a new generation so its planning date is cleared first.");
    await readOptimoPlanning(job);
  } catch (error) {
    if (job.version === resequenceVersion) setResequenceStatus(error.message);
  } finally {
    if (job.version === resequenceVersion) setResequenceBusy(false);
  }
});
resequenceElement("saveSequenceBtn").addEventListener("click", () => {
  if (resequenceBusy || deliverySaveInProgress || !resequenceJob?.result) return;
  try {
    assertResequenceCurrent(resequenceJob);
    const result = { ...resequenceJob.result };
    localStorage.setItem(resequenceJob.storageKey, JSON.stringify(result));
    applyPhoneSequence(resequenceJob.rows, result);
    resequenceElement("saveSequenceBtn").hidden = true;
    setResequenceStatus("New sequence saved on this phone. The shared workbook and delivery statuses are unchanged.");
  } catch (error) { setResequenceStatus(`Sequence not saved. ${error.message}`); }
});

// ================= PROCESS ROUTE EXCEL =================
// Core data flow: first sheet -> row objects -> one Leaflet marker per row.
// Required columns: LATITUDE, LONGITUDE, ROUTE, DAY. Optional: CSADR#, CSSDIR, CSSTRT, CSSFUX
// (address), SIZE, QTY, BINNO (popup), SEQNO (sequence), del_status ("Delivered" marks completed stops).
// Rebuilds sequenceGroups, resets map/selection, then fills routeDayGroups by day or Delivered.
function processExcelBuffer(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(ws);
  resetAddressSearch();
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

const status = isDeliveredRow(row) ? "delivered" : "";

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
const popupContent = () => `
  <div style="font-size:14px; line-height:1.4;">
    <div style="font-weight:bold; font-size:15px; margin-bottom:6px;">
      ${fullAddress || "Address not available"}
    </div>

    <div><strong>Container Size:</strong> ${row["SIZE"] || "-"}</div>
    <div><strong>Quantity:</strong> ${row["QTY"] || "-"}</div>
    <div class="cart-progress"><strong>${cartProgressText(row)}</strong></div>
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
    attachQuantityBadge(marker, row);
    marker.on("click", event => {
      if (optimoLocationPicker) { setOptimoPickPoint(event.latlng || marker.getLatLng()); return; }
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
  const recordCartsBtn = document.getElementById("recordCartsBtn");

  if (window.innerWidth <= 900) {
    quickActions.insertBefore(locateBtn, moreBtn);
    quickActions.insertBefore(copyLocationBtn, moreBtn);
    moreActions.append(clearBtn, undoBtn, streetLabel, refreshBtn);
    moreActions.prepend(loadLogBtn);
    dock.querySelector(".delivery-controls-main").append(recordCartsBtn);
    dock.insertBefore(saveStatus, quickActions);
  } else {
    selectionBox.insertBefore(clearBtn, desktopContainer);
    desktopContainer.append(locateBtn, copyLocationBtn, recordCartsBtn, completeBtn, saveStatus, undoBtn, streetLabel, loadLogBtn);
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
    isDeliveredRow(marker._rowRef) &&
    isStopSelected(marker, selectionTester)
  );

  if (hasDeliveredInSelection) {
    undoBtn.classList.add("pulse");
  } else {
    undoBtn.classList.remove("pulse");
  }
}









function setupPocketLock() {
  const dialog = document.getElementById("pocketLock");
  const button = document.getElementById("pocketUnlockBtn");
  const status = document.getElementById("pocketLockStatus");
  let hold = null;
  let timer = null;

  function cancelHold() {
    clearTimeout(timer);
    hold = null;
    button.classList.remove("holding");
    status.textContent = "";
  }

  function startHold(input, x, y) {
    cancelHold();
    hold = { input, x, y, started: performance.now() };
    button.classList.add("holding");
    timer = setTimeout(() => { status.textContent = "Release to unlock"; }, 2000);
  }

  function finishHold(input) {
    const ready = hold && hold.input === input && performance.now() - hold.started >= 2000;
    cancelHold();
    if (!ready) return;
    // Keep the modal through the release's click so it cannot hit the map underneath.
    setTimeout(() => {
      dialog.close();
      document.body.classList.remove("pocket-locked");
    }, 0);
  }

  document.getElementById("lockScreenBtn").addEventListener("click", () => {
    cancelHold();
    document.body.classList.add("pocket-locked");
    dialog.showModal();
    button.focus({ preventScroll: true });
  });
  dialog.addEventListener("cancel", event => event.preventDefault());
  dialog.addEventListener("contextmenu", event => event.preventDefault());
  dialog.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
  dialog.addEventListener("pointerdown", event => {
    if (hold || !event.isPrimary) { cancelHold(); return; }
    if (event.target !== button || event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    startHold(event.pointerId, event.clientX, event.clientY);
  });
  button.addEventListener("pointermove", event => {
    if (hold && hold.input === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 18) cancelHold();
  });
  button.addEventListener("pointerup", event => {
    event.preventDefault();
    finishHold(event.pointerId);
  });
  button.addEventListener("pointercancel", cancelHold);
  button.addEventListener("lostpointercapture", cancelHold);
  // Capture keyboard input before app shortcuts; Escape must not dismiss the lock.
  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, event => {
      if (!dialog.open) return;
      event.stopImmediatePropagation();
      if (event.key === "Tab") { cancelHold(); return; }
      event.preventDefault();
      if (event.target !== button || ![" ", "Enter"].includes(event.key)) { cancelHold(); return; }
      if (type === "keyup") finishHold(event.key);
      else if (!event.repeat) startHold(event.key);
    }, true);
  }
  button.addEventListener("blur", cancelHold);
  window.addEventListener("blur", cancelHold);
  window.addEventListener("pagehide", cancelHold);
  window.addEventListener("resize", cancelHold);
  document.addEventListener("visibilitychange", cancelHold);
}

function initApp() { //begining of initApp=================================================================

setupPocketLock();
const openCartCounts = setupCartCounts();
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
    scheduleAddressNumberRefresh();
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
    resetAddressSearch();


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
  
// ================= MAP ADDRESS SEARCH =================

const searchInput = document.getElementById("mapSearchInput");
const searchBtn   = document.getElementById("mapSearchBtn");
const resultsPanel = document.getElementById("searchResultsPanel");
const resultsList = document.getElementById("searchResultsList");
const searchStatus = document.getElementById("searchResultsStatus");
const moreSearchBtn = document.getElementById("moreSearchResults");
const searchTotals = document.getElementById("searchCartTotals");
const searchQuickFilters = document.getElementById("searchQuickFilters");
const multipleCartsBtn = document.getElementById("searchMultipleCarts");
const searchRouteFilter = document.getElementById("searchRouteFilter");
const searchDayFilter = document.getElementById("searchDayFilter");
const searchScopeHint = document.getElementById("searchScopeHint");
const addressCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const cartNumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 });
let searchTimer;
let searchLimit = 50;
let searchPreview = null;
let previewMarker = null;
let searchDeliveryFilter = "all";
let searchMultipleCarts = false;
let searchActive = false;

function searchDayValue(row) {
  const day = String(rowDay(row) ?? "").trim();
  return day && Number.isFinite(Number(day)) ? String(Number(day)) : day;
}

function searchHasFilters() {
  return searchDeliveryFilter !== "all" || searchMultipleCarts || searchRouteFilter.value || searchDayFilter.value;
}

function updateSearchFilterControls() {
  searchQuickFilters.querySelectorAll("[data-search-status]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.searchStatus === searchDeliveryFilter &&
      (searchDeliveryFilter !== "all" || !searchMultipleCarts)));
  });
  multipleCartsBtn.setAttribute("aria-pressed", String(searchMultipleCarts));
  searchScopeHint.textContent = [searchRouteFilter.value ? `Route ${searchRouteFilter.value}` : "",
    searchDayFilter.value ? dayName(Number(searchDayFilter.value)) || `Day ${searchDayFilter.value}` : ""].filter(Boolean).join(" · ") || "All";
}

function syncSearchScopeOptions() {
  const routes = new Set(), days = new Set();
  Object.values(routeDayGroups).forEach(group => group.layers.forEach(marker => {
    const row = marker._rowRef;
    const route = String(rowRoute(row) ?? "").trim();
    const day = searchDayValue(row);
    if (route) routes.add(route);
    if (day) days.add(day);
  }));
  [[searchRouteFilter, routes, "All routes"], [searchDayFilter, days, "All days"]].forEach(([select, values, label]) => {
    const previous = select.value;
    select.replaceChildren(new Option(label, ""));
    [...values].sort(addressCollator.compare).forEach(value => select.add(new Option(
      select === searchDayFilter ? dayName(Number(value)) || `Day ${value}` : value, value)));
    select.value = values.has(previous) ? previous : "";
  });
  updateSearchFilterControls();
}

function clearSearchPreview() {
  if (searchPreview) map.removeLayer(searchPreview);
  searchPreview = null;
  previewMarker = null;
}

resetAddressSearch = () => {
  clearTimeout(searchTimer);
  clearSearchPreview();
  searchInput.value = "";
  searchDeliveryFilter = "all";
  searchMultipleCarts = false;
  searchRouteFilter.value = "";
  searchDayFilter.value = "";
  searchActive = false;
  syncSearchScopeOptions();
  searchLimit = 50;
  resultsList.replaceChildren();
  searchStatus.textContent = "";
  searchTotals.textContent = "";
  moreSearchBtn.hidden = true;
  resultsPanel.classList.add("hidden");
};

function searchStopPopup(row) {
  const popup = document.createElement("div");
  const address = document.createElement("strong");
  address.textContent = formatStopAddress(row);
  popup.append(address);
  const delivered = isDeliveredRow(row);
  const details = [`Route ${rowRoute(row)} · ${dayName(Number(rowDay(row))) || `Day ${rowDay(row)}`}`,
    delivered ? "Delivered" : "Pending", cartProgressText(row), `Quantity: ${row.QTY ?? "—"}`, `Container size: ${row.SIZE ?? "—"}`];
  const sequence = rowSequence(row);
  if (sequence !== null) details.push(`Sequence: ${sequence}`);
  if (row.BINNO != null && String(row.BINNO).trim()) details.push(`Bin: ${row.BINNO}`);
  details.forEach(text => { const line = document.createElement("div"); line.textContent = text; popup.append(line); });
  return popup;
}

function showSearchStop(marker) {
  clearSearchPreview();
  previewMarker = marker;
  const latlng = getLayerLatLng(marker);
  // A separate preview finds hidden stops without revealing/selecting their real markers.
  searchPreview = L.circleMarker(latlng, {
    renderer: canvasRenderer, radius: 14, color: "#2563eb", weight: 3, fill: false, interactive: false
  }).bindPopup(searchStopPopup(marker._rowRef)).addTo(map);
  searchInput.blur();
  if (window.innerWidth <= 900) closeMobileMenu();
  map.setView(latlng, 18, { animate: false });
  searchPreview.openPopup();
  resultsList.querySelectorAll(".search-result-item").forEach(button => button.classList.toggle("is-current", button._stopMarker === marker));
}

function renderAddressSearch() {
  const query = searchInput.value.trim();
  if (!query && !searchHasFilters() && !searchActive) {
    clearSearchPreview();
    resultsList.replaceChildren();
    searchStatus.textContent = "";
    searchTotals.textContent = "";
    moreSearchBtn.hidden = true;
    resultsPanel.classList.add("hidden");
    return;
  }
  const tokens = addressSearchTokens(query);
  const binQuery = binSearchText(query.replace(/^bin\s*[:#]?\s+/i, ""));
  const matches = [];
  let stopCount = 0;
  Object.values(routeDayGroups).forEach(group => group.layers.forEach(marker => {
    stopCount++;
    const row = marker._rowRef;
    const delivered = isDeliveredRow(row);
    if ((searchDeliveryFilter === "pending" && delivered) || (searchDeliveryFilter === "delivered" && !delivered) ||
      (searchMultipleCarts && multiCartQuantity(row) === null) ||
      (searchRouteFilter.value && String(rowRoute(row) ?? "").trim() !== searchRouteFilter.value) ||
      (searchDayFilter.value && searchDayValue(row) !== searchDayFilter.value)) return;
    const data = marker._addressSearch || (marker._addressSearch = addressSearchData(row));
    const addressScore = tokens.length ? addressSearchScore(data, tokens) : null;
    // Bin identifiers use their own normalization, without street/direction aliases.
    const binScore = binQuery && data.bin.startsWith(binQuery) ? (data.bin === binQuery ? 600 : 100) : null;
    const score = !query ? 0 : addressScore === null ? binScore : binScore === null ? addressScore : Math.max(addressScore, binScore);
    if (score !== null) matches.push({ marker, score, address: formatStopAddress(marker._rowRef) });
  }));
  matches.sort((a, b) => b.score - a.score || addressCollator.compare(a.address, b.address) ||
    addressCollator.compare(String(rowRoute(a.marker._rowRef)), String(rowRoute(b.marker._rowRef))));
  resultsPanel.classList.remove("hidden");
  resultsList.replaceChildren();
  moreSearchBtn.hidden = matches.length <= searchLimit;
  moreSearchBtn.textContent = `Show ${Math.min(50, Math.max(0, matches.length - searchLimit))} more`;
  searchStatus.textContent = !stopCount ? "Open a route file to search its stops."
    : query && !tokens.length && !binQuery ? "Enter an address or bin number."
    : !matches.length ? (query ? `No matches for “${query}” with these filters.` : "No stops match these filters.")
    : `${matches.length} ${matches.length === 1 ? "match" : "matches"}${matches.length > searchLimit ? ` · showing ${searchLimit}` : ""} · includes hidden layers`;
  let remainingCarts = 0, missingQuantities = 0;
  matches.forEach(({ marker }) => {
    const row = marker._rowRef;
    if (isDeliveredRow(row)) return;
    const quantity = searchCartQuantity(row);
    if (quantity === null) missingQuantities++;
    else remainingCarts += Math.max(0, quantity - (deliveredCartCount(row) || 0));
  });
  searchTotals.textContent = stopCount ? `${matches.length} ${matches.length === 1 ? "stop" : "stops"} · ${cartNumberFormat.format(remainingCarts)}${missingQuantities ? " known" : ""} ${remainingCarts === 1 ? "cart" : "carts"} remaining${missingQuantities ? ` · ${missingQuantities} ${missingQuantities === 1 ? "stop missing" : "stops missing"} QTY` : ""}` : "";
  matches.slice(0, searchLimit).forEach(({ marker, address }) => {
    const row = marker._rowRef;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-item";
    button.classList.toggle("is-current", marker === previewMarker);
    button._stopMarker = marker;
    const title = document.createElement("span");
    title.className = "search-result-address";
    title.textContent = address;
    const detail = document.createElement("span");
    detail.className = "search-result-detail";
    const sequence = rowSequence(row);
    detail.textContent = `Route ${rowRoute(row)} · ${dayName(Number(rowDay(row))) || `Day ${rowDay(row)}`}${sequence !== null ? ` · Seq ${sequence}` : ""}${row.BINNO != null && String(row.BINNO).trim() ? ` · Bin ${row.BINNO}` : ""}`;
    const state = document.createElement("span");
    state.className = "search-result-state";
    const delivered = isDeliveredRow(row);
    state.dataset.delivered = String(delivered);
    state.textContent = `${delivered ? "✓ Delivered" : "Pending"}${row.QTY != null && String(row.QTY).trim() ? ` · ${row.QTY} ${Number(row.QTY) === 1 ? "cart" : "carts"}` : ""}${map.hasLayer(marker) ? "" : " · Hidden layer"}`;
    const progress = document.createElement("span");
    progress.className = "search-result-detail";
    progress.textContent = cartProgressText(row);
    button.append(title, detail, state, progress);
    button.addEventListener("click", () => showSearchStop(marker));
    resultsList.append(button);
  });
  if (searchPreview && previewMarker) searchPreview.setPopupContent(searchStopPopup(previewMarker._rowRef));
}

refreshAddressSearch = () => { syncSearchScopeOptions(); renderAddressSearch(); };

function searchMapByAddress() {
  clearTimeout(searchTimer);
  clearSearchPreview();
  searchActive = true;
  searchLimit = 50;
  renderAddressSearch();
}
  // Hook up search button + Enter key
if (searchBtn) {
  searchBtn.addEventListener("click", searchMapByAddress);
}

if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    clearSearchPreview();
    searchLimit = 50;
    searchActive = Boolean(searchInput.value.trim() || searchHasFilters());
    if (!searchInput.value.trim()) renderAddressSearch();
    else searchTimer = setTimeout(renderAddressSearch, 180);
  });
  searchInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      searchMapByAddress();
    } else if (e.key === "Escape") {
      resetAddressSearch();
    }
  });
}
moreSearchBtn.addEventListener("click", () => { searchLimit += 50; renderAddressSearch(); });
document.getElementById("clearSearchResults").addEventListener("click", () => { resetAddressSearch(); searchInput.focus(); });
searchQuickFilters.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button === multipleCartsBtn) searchMultipleCarts = !searchMultipleCarts;
  else {
    searchDeliveryFilter = button.dataset.searchStatus;
    if (searchDeliveryFilter === "all") searchMultipleCarts = false;
  }
  updateSearchFilterControls();
  searchMapByAddress();
});
[searchRouteFilter, searchDayFilter].forEach(select => select.addEventListener("change", () => {
  updateSearchFilterControls();
  searchMapByAddress();
}));
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

function selectedDeliveryStops() {
  const tester = createSelectionTester();
  const selected = [];
  Object.entries(routeDayGroups).forEach(([key, group]) => {
    group.layers.forEach(marker => {
      if (marker._rowRef && isStopSelected(marker, tester)) selected.push({ key, marker, row: marker._rowRef });
    });
  });
  return selected;
}

function setupCartCounts() {
  const el = id => document.getElementById(id);
  const dialog = el("cartCountsDialog");
  let snapshot = null;
  let saving = false;

  el("multipleCartsOnly").addEventListener("change", () => {
    applyFilters();
    map.closePopup();
    el("mobileStopPicker").hidden = true;
  });

  function preview() {
    if (!snapshot) return null;
    const operation = el("cartCountOperation").value;
    const perRecord = operation === "each";
    const adding = operation !== "set";
    const changes = new Map();
    let error = "";
    const list = el("cartCountPreview");
    list.replaceChildren();
    snapshot.selected.forEach(({ row }, index) => {
      const entry = snapshot.entries[index];
      const amount = (perRecord ? entry.input : el("cartCountAmount")).value.trim();
      const value = Number(amount);
      const valid = amount !== "" && Number.isSafeInteger(value) && value >= (adding && !perRecord ? 1 : 0);
      if (!valid) error ||= perRecord ? "Enter a whole-number quantity for every record. Use 0 for a stop with no carts delivered this visit."
        : adding ? "Enter a whole number of at least 1." : "Enter a whole number of 0 or more.";
      const total = cartTotal(row);
      const current = deliveredCartCount(row);
      const next = adding ? current + value : value;
      if (total === null) error ||= "Every selected stop needs a positive whole-number QTY. Deselect stops with missing or invalid quantities.";
      else if (next > total) error ||= "This would exceed QTY at one or more stops. Lower the count or change the selection; no stops will be saved.";
      if (!perRecord || value > 0) changes.set(row, { del_qty: next, del_status: next === total ? "Delivered" : "" });
      entry.progress.textContent = total === null ? "Invalid QTY" : valid ? `After saving: ${next} of ${total} delivered · ${Math.max(0, total - next)} remaining` : `${current} of ${total} delivered · ${total - current} remaining`;
      entry.input.setAttribute("aria-invalid", String(!valid || total === null || next > total));
      if (index >= 50) return;
      const item = document.createElement("li");
      item.textContent = `${formatStopAddress(row)} · Bin ${String(row.BINNO ?? "—")} · ${total === null ? "Invalid QTY" : `${current} → ${Number.isSafeInteger(next) ? next : "?"} of ${total} delivered`}`;
      list.append(item);
    });
    if (!error && !changes.size) error = "Enter at least one delivered cart to save. Use Close to cancel.";
    el("cartCountSummary").textContent = `${snapshot.selected.length} selected ${snapshot.selected.length === 1 ? "stop" : "stops"}. ${perRecord ? "Enter carts delivered this visit for each record, not the total delivered so far." : `${snapshot.selected.length > 50 ? "Showing the first 50 below. " : ""}Counts apply to each selected stop separately.`}`;
    el("cartCountStatus").textContent = error;
    el("saveCartCountsBtn").disabled = Boolean(error) || saving;
    return error ? null : changes;
  }

  function syncMode() {
    const perRecord = el("cartCountOperation").value === "each";
    el("cartCountBulkAmount").hidden = perRecord;
    el("cartCountAmount").disabled = perRecord;
    el("cartCountEntries").hidden = !perRecord;
    el("cartCountPreview").hidden = perRecord;
    snapshot.entries.forEach(entry => { entry.input.disabled = !perRecord; });
    preview();
  }

  function open(selected, perRecord = el("multipleCartsOnly").checked) {
    if (deliverySaveInProgress || resequenceBusy) return;
    if (!selected.length) return;
    snapshot = { selected, rows: window._currentRows, workbook: window._currentWorkbook, filePath: window._currentFilePath, entries: [] };
    el("cartCountEntries").replaceChildren();
    selected.forEach(({ row }, index) => {
      const card = document.createElement("div");
      card.className = "cart-count-entry";
      const info = document.createElement("div");
      const address = document.createElement("strong");
      address.textContent = formatStopAddress(row);
      const detail = document.createElement("span");
      detail.textContent = `Bin ${String(row.BINNO ?? "—")} · Route ${rowRoute(row)} · ${dayName(Number(rowDay(row))) || rowDay(row)}`;
      info.append(address, detail);
      const label = document.createElement("label");
      label.htmlFor = `cartCountEntry${index}`;
      label.append(document.createTextNode("This visit"));
      const input = document.createElement("input");
      Object.assign(input, { id: label.htmlFor, type: "number", inputMode: "numeric", min: "0", max: String(Math.max(0, (cartTotal(row) || 0) - (deliveredCartCount(row) || 0))), step: "1", required: true });
      input.setAttribute("aria-label", `Carts delivered this visit: ${formatStopAddress(row)}, bin ${String(row.BINNO ?? "not provided")}, record ${index + 1}`);
      input.placeholder = `0–${input.max}`;
      label.append(input);
      const progress = document.createElement("p");
      progress.id = `cartCountEntryProgress${index}`;
      input.setAttribute("aria-describedby", progress.id);
      input.addEventListener("input", preview);
      card.append(info, label, progress);
      el("cartCountEntries").append(card);
      snapshot.entries.push({ input, progress });
    });
    el("cartCountOperation").value = perRecord ? "each" : "add";
    el("cartCountAmount").value = "1";
    syncMode();
    dialog.showModal();
  }
  el("recordCartsBtn").addEventListener("click", () => open(selectedDeliveryStops()));
  el("cartCountOperation").addEventListener("change", syncMode);
  el("cartCountAmount").addEventListener("input", preview);
  el("closeCartCountsBtn").addEventListener("click", () => { if (!saving) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  el("cartCountsForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || deliverySaveInProgress || resequenceBusy || !snapshot) return;
    if (snapshot.rows !== window._currentRows || snapshot.workbook !== window._currentWorkbook || snapshot.filePath !== window._currentFilePath) {
      el("cartCountStatus").textContent = "The open file changed. Close this panel and select stops again.";
      return;
    }
    const changes = preview();
    if (!changes) return;
    saving = true;
    el("cartCountFields").disabled = true;
    el("closeCartCountsBtn").disabled = true;
    el("saveCartCountsBtn").disabled = true;
    el("cartCountStatus").textContent = "Saving cart counts… Keep the app open.";
    try {
      const saved = await persistDeliveryChanges(snapshot.selected.filter(({ row }) => changes.has(row)), changes, "cart counts updated");
      if (saved) dialog.close();
      else el("cartCountStatus").textContent = el("deliverySaveStatus").textContent;
    } finally {
      saving = false;
      el("cartCountFields").disabled = false;
      el("closeCartCountsBtn").disabled = false;
      el("saveCartCountsBtn").disabled = false;
    }
  });
  return open;
}

// Records one cart per stop, prompts for per-record quantities, or undoes completion.
// Flow: collect selected rows -> upload a new workbook to Supabase -> only on success mutate
// row.del_status, move markers between routeDayGroups keys, refresh controls and sequence styling.
// Uploads overwrite the whole file, so never mutate rows before the upload succeeds.
// Assumes a single editing phone at a time (viewers only read); there is no merge with remote changes.
async function saveSelectedDeliveryStatus(markDelivered) {
  if (deliverySaveInProgress || resequenceBusy) return;
  const rows = window._currentRows;
  const workbook = window._currentWorkbook;
  const filePath = window._currentFilePath;
  if (!rows || !workbook || !filePath) {
    setDeliverySaveStatus("error", "Not saved — load a route file first.");
    return;
  }

  const selected = selectedDeliveryStops().filter(({ row }) => isDeliveredRow(row) !== markDelivered);
  if (!selected.length) {
    setDeliverySaveStatus("error", markDelivered
      ? "Select undelivered stops first."
      : "Select delivered stops to undo.");
    return;
  }
  if (markDelivered && document.getElementById("multipleCartsOnly").checked) return openCartCounts(selected, true);
  if (!markDelivered && !confirm("Are you sure you want to undo the selected Delivered stops?")) return;

  if (markDelivered && selected.some(({ row }) => multiCartQuantity(row) !== null && cartTotal(row) === null)) {
    setDeliverySaveStatus("error", "Not saved — multiple-cart records need a whole-number QTY. Correct the quantity or deselect those records.");
    return;
  }
  const changes = new Map(selected.map(({ row }) => {
    const total = cartTotal(row);
    const next = markDelivered ? (total === null ? "" : Math.min(total, deliveredCartCount(row) + 1)) : 0;
    return [row, { del_status: markDelivered && (total === null || next === total) ? "Delivered" : "", del_qty: next }];
  }));
  return persistDeliveryChanges(selected, changes, markDelivered ? "deliveries recorded" : "restored");
}

async function persistDeliveryChanges(selected, changes, action) {
  if (deliverySaveInProgress || resequenceBusy) return false;
  const rows = window._currentRows;
  const workbook = window._currentWorkbook;
  const filePath = window._currentFilePath;
  if (!rows || !workbook || !filePath) {
    setDeliverySaveStatus("error", "Not saved — load a route file first.");
    return false;
  }
  const count = selected.length;
  const stopLabel = count === 1 ? "stop" : "stops";
  const nextRows = rows.map(row => changes.has(row) ? { ...row, ...changes.get(row) } : row);
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
    return false;
  } finally {
    clearInterval(progressTimer);
  }

  // A route opened during the upload must keep its own markers and workbook.
  const routeIsCurrent = window._currentRows === rows &&
    window._currentWorkbook === workbook && window._currentFilePath === filePath;
  if (routeIsCurrent) {
    window._currentWorkbook = savedWorkbook;
    selected.forEach(({ key, marker, row }) => {
      Object.assign(row, changes.get(row));
      const group = routeDayGroups[key];
      if (!group?.layers.includes(marker)) return;
      group.layers = group.layers.filter(layer => layer !== marker);
      const nextKey = `${rowRoute(row)}|${isDeliveredRow(row) ? "Delivered" : rowDay(row)}`;
      if (!routeDayGroups[nextKey]) routeDayGroups[nextKey] = { layers: [] };
      getSymbol(nextKey);
      routeDayGroups[nextKey].layers.push(marker);
      marker._base.symbol = { ...marker._base.symbol, color: symbolMap[nextKey].color };
      restoreMarkerStyle(marker, nextKey);
      refreshQuantityBadge(marker);
      if (marker.isPopupOpen()) marker.getPopup().update();
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

  const fileNote = routeIsCurrent ? "" : ` in ${filePath}`;
  setDeliverySaveStatus("saved", `Saved — ${count} ${stopLabel} ${action}${fileNote}.`);
  return true;
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
