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
 *  10. Saved files (profile copies, reviewed sync, shared Cart Delivery tab)
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
 *   - del_qty tracks carts delivered; profile saves and reviewed sync require confirmed server revisions.
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
let workAreas = null;
let selectedPendingStopCount = 0;
let resetAddressSearch = () => {};
let refreshAddressSearch = () => {};
let refreshStreetLabels = () => {};

function updateDeliveryButtons() {
  const count = selectedPendingStopCount;
  const readOnly = !profileState.user || profileState.workspace?.mode !== "copy" || profileState.busy;
  const perRecord = document.getElementById("multipleCartsOnly").checked;
  const label = deliverySaveInProgress
    ? "Saving…"
    : perRecord ? "Enter carts delivered" : "Deliver 1 cart per stop";

  ["completeStopsBtn", "completeStopsBtnMobile"].forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    button.textContent = label;
    button.disabled = readOnly || deliverySaveInProgress || resequenceBusy || count === 0;
    button.setAttribute("aria-busy", String(deliverySaveInProgress));
    button.title = !count ? "Select undelivered stops on the map first" : perRecord
      ? "Enter the carts delivered this visit for each selected record"
      : "Add one delivered cart to each selected stop. Use Record carts to specify a different count.";
  });
  const undoButton = document.getElementById("undoDeliveredBtn");
  if (undoButton) undoButton.disabled = readOnly || deliverySaveInProgress || resequenceBusy;
  const cartButton = document.getElementById("recordCartsBtn");
  if (cartButton) {
    cartButton.disabled = readOnly || deliverySaveInProgress || resequenceBusy || Number(document.getElementById("selectionCount").textContent) === 0;
    cartButton.textContent = document.getElementById("multipleCartsOnly").checked ? "Record carts · QTY 2+ filter on" : "Record carts";
  }
  document.querySelectorAll('.stop-delivery-action').forEach(button => {
    button.disabled = readOnly || deliverySaveInProgress || resequenceBusy || button.dataset.unavailable === 'true';
  });
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
  renderRouteContext();
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


document.addEventListener("DOMContentLoaded", () => {
  initApp();
  document.addEventListener("DOMContentLoaded", initApp);
// ================= SUN MODE TOGGLE =================

const sunToggle = document.getElementById("sunModeToggle");
const sunToggleText = document.getElementById("sunToggleText");

function updateSunToggleText() {
  if (!sunToggle || !sunToggleText) return;
  sunToggleText.textContent = sunToggle.checked ? "Light Mode" : "Dark Mode";
  sunToggle.closest('label').title = sunToggle.checked ? 'Switch to dark mode' : 'Switch to light mode';
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
    if (!optimoLocationPicker && !workAreas?.mapActive) map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 1.2 });

   

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
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: "cartdelivery.profiles.auth" } });

// Profile workbooks are server-versioned; no browser can overwrite an original.
const profileState = { user: null, workspace: null, busy: false, generation: 0, preview: null, syncRequest: null, shareConfirmation: null, authMode: "signin" };
const teamUploadState = { file: null, result: null, added: false, resume: false, inspection: null, mapping: null, inspecting: false, inspectToken: 0, cancelInspect: null };
const profileElement = id => document.getElementById(id);
let recordSingleStop = () => {};
function rememberedDeliveryView() {
  if (!profileState.user) return null;
  try {
    const view = JSON.parse(localStorage.getItem(`cartdelivery.resume.${profileState.user.id}`));
    return view?.fileId && typeof view.name === 'string' && Array.isArray(view.routes) && Array.isArray(view.days) ? view : null;
  } catch { return null; }
}
function rememberDeliveryView(force = false) {
  const { workspace, user, busy } = profileState;
  if ((!force && busy) || !user || workspace?.mode !== 'copy' || workspace.owner !== user.id || !window._currentRows) return;
  const center = map.getCenter();
  const checked = selector => [...document.querySelectorAll(selector)].filter(input => input.checked).map(input => input.value);
  try {
    localStorage.setItem(`cartdelivery.resume.${user.id}`, JSON.stringify({
      fileId: workspace.fileId, name: workspace.name,
      routes: checked('#routeCheckboxes input'), days: checked('#dayCheckboxes input'),
      layers: layerVisibilityState, multiple: profileElement('multipleCartsOnly').checked,
      center: [center.lat, center.lng], zoom: map.getZoom()
    }));
  } catch { /* Storage may be unavailable in private browsing. */ }
}
function restoreDeliveryView(view) {
  if (!view || view.fileId !== profileState.workspace?.fileId) return;
  document.querySelectorAll('#routeCheckboxes input').forEach(input => { input.checked = view.routes.includes(input.value); });
  document.querySelectorAll('#dayCheckboxes input').forEach(input => { input.checked = view.days.includes(input.value); });
  layerVisibilityState = view.layers && typeof view.layers === 'object' ? { ...view.layers } : {};
  profileElement('multipleCartsOnly').checked = Boolean(view.multiple);
  buildRouteDayLayerControls(); applyFilters();
  if (Array.isArray(view.center) && view.center.length === 2 && view.center.every(Number.isFinite) && Math.abs(view.center[0]) <= 90 && Number.isFinite(view.zoom)) {
    map.setView(view.center, Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), view.zoom)), { animate: false });
  }
}
function copySaveSummary() {
  if (deliverySaveInProgress) return 'Saving to my copy…';
  if (profileElement('deliverySaveStatus')?.dataset.state === 'error') return 'Save not confirmed · Retry or reload my copy';
  const count = profileState.workspace?.pending || 0;
  return `Saved · ${count ? `${count} ${count === 1 ? 'stop' : 'stops'} waiting to sync` : 'Nothing waiting to sync'}`;
}
function lastSyncSummary() {
  const workspace = profileState.workspace;
  if (!workspace || workspace.mode !== 'copy') return '';
  if (!Object.hasOwn(workspace, 'lastSyncedAt')) return 'Last sync time unavailable';
  return workspace.lastSyncedAt ? `Last sync: ${new Date(workspace.lastSyncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not synced yet';
}
const profileUsername = user => user?.email?.split("@")[0] || "";
function profileMessage(error) {
  const code = error?.message || String(error);
  if (code.includes('MAPPING_SETUP_REQUIRED')) return 'Column mapping needs a server update before this file can be uploaded. Ask the app administrator to finish the update.';
  if (code.includes('INVALID_MAPPING')) return 'Check your column matches. Latitude and longitude need separate columns, and each column can only be used once.';
  if (code.includes('INVALID_HEADERS')) return 'Use column names under 200 characters and avoid reserved names such as __rowNum__, constructor or prototype.';
  if (code.includes("TEAM_VIEW_SETUP_REQUIRED")) return "Team viewing needs a server update. Ask the app administrator to finish the update, then try again.";
  if (code.includes("STALE_VERSION")) return "Your copy or the team Excel changed on another device. Reload your saved copy, then review again. Nothing from this attempt was applied.";
  if (code.includes("NAME_EXISTS")) return "A team Excel with this name already exists. Choose it from Saved Files, or rename the new file.";
  if (code.includes("SIGN_IN_REQUIRED")) return "Sign in to your delivery profile first.";
  if (code.includes('PROFILE_DISABLED') || /banned/i.test(code)) return 'This profile’s sign-in is disabled. Ask the administrator to enable it.';
  if (code.includes("UNRESOLVED_CONFLICT")) return "Choose which values to keep for every highlighted stop before syncing.";
  if (code.includes("DUPLICATE_HEADERS")) return "This workbook has duplicate column headings. Give each column a unique heading before importing.";
  if (code.includes("INVALID_MACRO_WORKBOOK")) return "Macro-enabled workbooks are not supported. Export an XLSX copy without macros first.";
  if (code.includes("FILE_TOO_LARGE")) return "This workbook is too large. The import limit is 50 MB.";
  if (code.includes("CLIENT_UPDATE_REQUIRED")) return "Refresh the app to use the updated delivery profiles.";
  if (code.includes("IMPORT_DEVICE_LIMIT")) return "This device could not finish reading the Excel file. Import it once from a computer, then reopen it on your phone.";
  if (code.includes("INVALID_ROW_COUNT")) return "Import a first sheet containing between 1 and 100,000 records.";
  if (code.includes("WORKER_RESOURCE_LIMIT")) return "The server ran out of resources while processing this workbook. Reopen your copy to check what saved; if it still cannot open, the workbook needs administrator attention.";
  if (code.includes("already registered")) return "That username already exists. Choose Sign in if it is yours, or try a different username.";
  if (code.includes("Invalid login credentials")) return "The username or password is incorrect.";
  if (code.includes("SETUP_REQUIRED")) return "Delivery profiles need the Supabase setup first. No original files have been changed.";
  if (code.includes("INVALID_")) return "The changes could not be accepted. Reopen your copy and check the selected records and quantities.";
  return "Could not confirm the request. Check your connection and retry, or reopen your copy to check what saved.";
}
async function profileApi(body) {
  const generation = profileState.generation;
  const { data: { session } } = await sb.auth.getSession();
  const publicRead = ["public-list", "public-original", "public-rows", "public-export-source"].includes(body.action);
  if (!session && !publicRead) throw new Error("SIGN_IN_REQUIRED");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/profile-workbooks`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, ...(!publicRead && session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify(body), cache: "no-store"
      });
      if (publicRead && (response.status === 401 || response.status === 404)) throw new Error("TEAM_VIEW_SETUP_REQUIRED");
      if (response.status === 404) throw new Error("SETUP_REQUIRED");
      if (response.status === 546) throw new Error("WORKER_RESOURCE_LIMIT");
      if (response.status >= 500 && !attempt) continue;
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "REQUEST_FAILED");
      if (generation !== profileState.generation) throw new Error("SIGN_IN_REQUIRED");
      return result;
    } catch (error) {
      if (attempt || !(error instanceof TypeError)) throw error;
    }
  }
}
function renderProfileState() {
  const { user, workspace, busy } = profileState;
  syncSavedFilesGuide();
  const username = profileUsername(user);
  profileElement("profileWorkspaceBtn").textContent = user ? 'Profile' : 'Sign in';
  profileElement('profileWorkspaceBtn').setAttribute('aria-label', user ? `Open delivery profile for ${username}` : 'Sign in to your delivery account');
  profileElement("profileTitle").textContent = user ? "My delivery work" : profileState.authMode === "create" ? "Create your account" : "Welcome back";
  profileElement("profileAuthForm").hidden = Boolean(user);
  profileElement("profileSignedIn").hidden = !user;
  profileElement("profileAccountName").textContent = username;
  profileElement("profileFileSummary").textContent = workspace?.name || "Open a file to start your day";
  profileElement("profileWorkspaceLabel").textContent = !workspace ? "GET STARTED" : workspace.mode === "original" ? user ? "TEAM EXCEL" : "TEAM EXCEL · VIEW ONLY" : "YOUR SAVED COPY";
  profileElement("profileSaveSummary").textContent = !workspace
    ? "Your saved copies follow your account. Choose a file to continue where you left off."
    : workspace.mode === "original" ? "You're viewing the shared team Excel. Open your own copy to record deliveries."
    : workspace.pending ? `${workspace.pending} changed ${workspace.pending === 1 ? "stop is" : "stops are"} saved in your copy, ready to sync to team Excel.`
    : "No changes waiting to sync. You can check for team updates before you continue.";
  profileElement("profileChooseFileBtn").textContent = workspace ? "Choose another file" : "Choose a file";
  profileElement("profileChooseFileBtn").classList.toggle("profile-primary", !workspace);
  profileElement("profileContinueBtn").hidden = !workspace;
  const remembered = rememberedDeliveryView();
  profileElement('profileResumeBtn').hidden = Boolean(workspace) || !remembered;
  profileElement('profileResumeBtn').textContent = remembered ? `Continue where I left off — ${remembered.name}` : 'Continue where I left off';
  profileElement('profileLastSync').textContent = lastSyncSummary();
  profileElement("profileFileTools").hidden = !workspace;
  profileElement("profileReviewBtn").hidden = workspace?.mode !== "copy";
  profileElement("profileReviewBtn").textContent = workspace?.pending ? "Sync to team Excel" : "Check for team updates";
  profileElement("profileReviewBtn").classList.toggle("profile-primary", Boolean(workspace?.pending));
  profileElement("profileContinueBtn").classList.toggle("profile-primary", !workspace?.pending);
  profileElement("profileDialog").setAttribute("aria-busy", String(busy));
  profileElement("profileAuthForm").querySelectorAll("input").forEach(input => { input.disabled = busy; });
  document.querySelectorAll("#profileDialog button, #profileSyncDialog button, #profileShareDialog button, #fileManagerModal button").forEach(button => { button.disabled = busy; });
  profileElement("profileShareAcknowledged").disabled = busy;
  profileElement("commitProfileShareBtn").disabled = busy || !profileState.shareConfirmation || !profileElement("profileShareAcknowledged").checked;
  profileElement("profileSyncDialog").querySelectorAll("input, select").forEach(input => { input.disabled = busy || Boolean(profileState.syncRequest); });
  profileElement('profileSyncChanges').querySelectorAll('[data-page-disabled]').forEach(button => { button.disabled = busy || button.dataset.pageDisabled === 'true'; });
  const bulkConflicts = profileElement('profileApplyConflicts');
  if (bulkConflicts) bulkConflicts.disabled = busy || Boolean(profileState.syncRequest) || !profileElement('profileConflictRule').value;
  ["profileReviewBtn", "profileReloadCopyBtn", "profileHistoryBtn"].forEach(id => { profileElement(id).disabled = busy || !workspace; });
  profileElement("profileHistoryBtn").disabled = busy || !workspace?.fileId;
  profileElement("profileReviewBtn").disabled = busy || workspace?.mode !== "copy";
  profileElement("profileReloadCopyBtn").textContent = workspace?.mode === "original" ? "Open my own copy" : "Reload my saved copy";
  profileElement("profileReloadCopyBtn").classList.toggle("profile-primary", workspace?.mode === "original");
  if (typeof updateDeliveryButtons === "function") updateDeliveryButtons();
  renderRouteContext();
  renderTeamUpload();
  workAreas?.syncContext();
}
function renderRouteContext() {
  const { workspace, user, preview } = profileState;
  document.querySelectorAll(".route-context").forEach(banner => {
    const dialog = banner.closest("dialog");
    const sharing = preview?.changes.length > 0 && ["profileSyncDialog", "profileShareDialog"].includes(dialog?.id);
    banner.hidden = !workspace;
    const main = workspace?.mode === "original";
    banner.dataset.mode = sharing ? "sharing" : main ? "team" : "copy";
    banner.querySelector("strong").textContent = sharing ? "TEAM EXCEL · SYNC SUMMARY" : main ? user ? "TEAM EXCEL" : "TEAM EXCEL · VIEW ONLY" : `YOUR COPY · ${profileUsername(user)}`;
    banner.querySelector(".route-context-file").textContent = sharing ? preview.name : workspace?.name || "";
    banner.querySelector(".route-context-help").textContent = sharing ? "Check the totals before syncing to team Excel." : main ? "Delivery records are view only. Signed-in profiles can edit shared work areas." : "Delivery saves change your copy. Sync to team Excel when ready.";
    if (banner.id === "routeContext") {
      banner.querySelector(".route-context-help").textContent = main
        ? user ? "Deliveries view only · Shared work areas editable" : "View only · Sign in to manage work areas"
        : copySaveSummary();
      banner.querySelector('.route-context-help').title = main ? '' : lastSyncSummary();
    }
  });
}
function setupRouteContext() {
  const template = profileElement("routeContext");
  document.querySelectorAll("dialog:not(#pocketLock):not(#teamUploadDialog):not(#cartCountsDialog):not(#workAreasDialog):not(#adminDialog):not(#helpDialog), .modal-content").forEach(container => {
    const banner = template.cloneNode(true);
    banner.removeAttribute("id"); banner.removeAttribute("role");
    container.prepend(banner);
  });
  renderRouteContext();
}
function setProfileAuthMode(mode) {
  if (profileState.busy) return;
  profileState.authMode = mode;
  const create = mode === "create";
  profileElement("profileSignInMode").setAttribute("aria-pressed", String(!create));
  profileElement("profileCreateMode").setAttribute("aria-pressed", String(create));
  profileElement("profileSignInBtn").hidden = create;
  profileElement("createProfileBtn").hidden = !create;
  profileElement("profilePassword").autocomplete = create ? "new-password" : "current-password";
  profileElement("profileAuthIntro").textContent = create ? "One account keeps your saved delivery copies available on your phone and computer." : "Sign in with the same username on your phone or computer to open your saved copies.";
  profileElement("profileUsernameHelp").textContent = create ? "Choose 3–30 letters, numbers, underscores or hyphens. Start with a letter or number." : "Use your username, not an email address. Capitalization does not matter.";
  profileElement("profilePasswordHelp").textContent = create ? "At least 6 characters. No other password rules." : "Enter the password you used to create your account.";
  profileElement("profileStatus").textContent = "";
  renderProfileState();
}
async function profileTask(statusId, action) {
  if (profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  profileState.busy = true;
  profileElement(statusId).textContent = "Working…";
  delete profileElement(statusId).dataset.state;
  renderProfileState();
  try { await action(); }
  catch (error) { profileElement(statusId).textContent = profileMessage(error); profileElement(statusId).dataset.state = "error"; }
  finally { profileState.busy = false; renderProfileState(); }
}
function requireProfile() {
  if (profileState.user) return true;
  profileElement("fileManagerModal").style.display = "none";
  profileElement("profileStatus").textContent = "Sign in to open your saved delivery work.";
  if (!profileElement("profileDialog").open) profileElement("profileDialog").showModal();
  return false;
}
async function displayProfileWorkbook(result, mode = "copy") {
  const remembered = rememberedDeliveryView();
  const generation = profileState.generation;
  const rows = [];
  while (rows.length < result.rowCount) {
    const page = await profileApi({ action: mode === "original" ? "public-rows" : "rows", fileId: result.fileId, mode, offset: rows.length,
      copyRevision: result.copyRevision, masterRevision: result.masterRevision });
    if (!page.rows.length || page.offset !== rows.length || page.rowCount !== result.rowCount) throw new Error("ROW_STRUCTURE_CHANGED");
    rows.push(...page.rows);
  }
  if (generation !== profileState.generation) throw new Error("SIGN_IN_REQUIRED");
  profileState.workspace = { ...result, mode, owner: profileState.user?.id || null };
  if (remembered?.fileId !== result.fileId || mode !== 'copy') {
    layerVisibilityState = {};
    buildDayCheckboxes();
    profileElement('multipleCartsOnly').checked = false;
  }
  window._currentFilePath = result.name;
  processExcelBuffer(null, profileViewWorkbook(), rows);
  profileElement("profileStatus").textContent = "";
  delete profileElement("profileStatus").dataset.state;
  profileState.preview = null;
  profileState.syncRequest = null;
  profileState.shareConfirmation = null;
  renderProfileState();
  // Let the compact header settle before restoring the saved map center.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (generation !== profileState.generation) throw new Error('SIGN_IN_REQUIRED');
  map.invalidateSize({ pan: false });
  if (mode === 'copy') { restoreDeliveryView(remembered); rememberDeliveryView(true); }
}
function profileViewWorkbook() {
  // Map state needs a file handle; actual Excel cells are created only on export.
  return { SheetNames: ["Stops"], Sheets: { Stops: {} } };
}
async function importProfileFile(file, localFile = null, onProgress = showLoading, fieldMapping = null) {
  let bytes;
  let digest;
  if (localFile) {
    if (localFile.size > 50000000) throw new Error("FILE_TOO_LARGE");
    bytes = await localFile.arrayBuffer();
    digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
  }
  const prepared = await profileApi({ action: "import-start", name: file.name, sourceKey: file.sourceKey, digest, ...(fieldMapping ? { fieldMapping } : {}), requestId: crypto.randomUUID() });
  if (fieldMapping && (!prepared.fieldMapping || Object.keys(fieldMapping).length !== Object.keys(prepared.fieldMapping).length ||
    Object.entries(fieldMapping).some(([key, value]) => prepared.fieldMapping[key] !== value))) throw new Error('MAPPING_SETUP_REQUIRED');
  if (prepared.ready) return prepared;
  if (prepared.upload) {
    const { error } = await sb.storage.from(prepared.upload.bucket).uploadToSignedUrl(prepared.upload.path, prepared.upload.token, localFile);
    if (error) throw error;
  }
  if (!bytes) {
    const response = await fetch(prepared.url, { cache: "no-store" });
    if (!response.ok) throw new Error("REQUEST_FAILED");
    if (Number(response.headers.get("Content-Length")) > 50000000) throw new Error("FILE_TOO_LARGE");
    bytes = await response.arrayBuffer();
    if (bytes.byteLength > 50000000) throw new Error("FILE_TOO_LARGE");
  }
  onProgress("Reading your Excel file…");
  const worker = new Worker("profile-import-worker.js?v=20261012-delivery-ease");
  const request = (message, transfer = []) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("IMPORT_DEVICE_LIMIT")), 120000);
    worker.onmessage = ({ data }) => { clearTimeout(timeout); data.error ? reject(new Error(data.error)) : resolve(data); };
    worker.onerror = () => { clearTimeout(timeout); reject(new Error("IMPORT_DEVICE_LIMIT")); };
    worker.postMessage(message, transfer);
  });
  try {
    const { rowCount } = await request({ bytes, mapping: fieldMapping }, [bytes]);
    for (let offset = prepared.rowCount; offset < rowCount;) {
      onProgress(`Adding stops ${offset + 1}–${Math.min(offset + 250, rowCount)} of ${rowCount}…`);
      const { rows } = await request({ offset });
      if (!rows.length) throw new Error("INVALID_ROW_COUNT");
      await profileApi({ action: "import-batch", fileId: prepared.fileId, offset, rows, requestId: crypto.randomUUID() });
      offset += rows.length;
    }
    return await profileApi({ action: "import-finish", fileId: prepared.fileId, rowCount, requestId: crypto.randomUUID() });
  } finally { worker.terminate(); }
}
async function profileExportWorkbook() {
  const workspace = profileState.workspace;
  if (!workspace || workspace.legacy) return window._currentWorkbook;
  const generation = profileState.generation;
  const rows = window._currentRows.map(row => ({ ...row }));
  const { url } = await profileApi({ action: workspace.mode === "original" ? "public-export-source" : "export-source", fileId: workspace.fileId });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("REQUEST_FAILED");
  const workbook = XLSX.read(new Uint8Array(await response.arrayBuffer()), { type: "array", cellStyles: true, bookVBA: true, cellText: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const source = XLSX.utils.sheet_to_json(sheet);
  if (rows.length !== source.length) throw new Error("ROW_STRUCTURE_CHANGED");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const columns = new Map();
  for (let col = range.s.c; col <= range.e.c; col++) {
    const key = String(sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })]?.v ?? "");
    if (key) columns.set(key, col);
  }
  const exportColumns = new Map();
  for (const field of ['del_qty', 'del_status', 'delivery_notes']) {
    let header = workspace.fieldMapping ? workspace.fieldMapping[field] : field;
    if (!header) {
      header = field;
      for (let suffix = 1; columns.has(header); suffix++) header = `${field}_app${suffix === 1 ? '' : suffix}`;
    }
    exportColumns.set(field, header);
  }
  rows.forEach((row, index) => {
    for (const field of ["del_qty", "del_status", "delivery_notes"]) {
      const originalHeader = workspace.fieldMapping ? workspace.fieldMapping[field] : field;
      if (JSON.stringify(row[field] ?? null) === JSON.stringify((originalHeader ? source[index][originalHeader] : null) ?? null)) continue;
      const header = exportColumns.get(field);
      if (!columns.has(header)) {
        columns.set(header, ++range.e.c);
        XLSX.utils.sheet_add_aoa(sheet, [[header]], { origin: { r: range.s.r, c: range.e.c } });
      }
      XLSX.utils.sheet_add_aoa(sheet, [[row[field] ?? ""]], { origin: { r: source[index].__rowNum__, c: columns.get(header) } });
    }
  });
  if (generation !== profileState.generation || workspace !== profileState.workspace) throw new Error("SIGN_IN_REQUIRED");
  return workbook;
}
async function openProfileFile(file, mode = "copy") {
  if ((mode !== "original" && !requireProfile()) || profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  profileState.busy = true;
  renderProfileState();
  showLoading(mode === "copy" ? "Opening your saved copy…" : "Opening team Excel (view only)…");
  try {
    let fileId = file.fileId;
    if (!fileId && mode === "original") {
      // Unimported public sources can be viewed without creating database records.
      const generation = profileState.generation;
      const { data } = sb.storage.from(BUCKET).getPublicUrl(file.sourceKey);
      const response = await fetch(data.publicUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("REQUEST_FAILED");
      const bytes = await response.arrayBuffer();
      if (generation !== profileState.generation) throw new Error("SIGN_IN_REQUIRED");
      profileState.workspace = { ...file, mode, legacy: true, owner: profileState.user?.id || null };
      window._currentFilePath = file.name;
      processExcelBuffer(bytes);
      profileState.preview = null; profileState.syncRequest = null; profileState.shareConfirmation = null;
    } else {
      if (!fileId) ({ fileId } = await importProfileFile(file));
      const result = await profileApi({ action: mode === "copy" ? "open" : "public-original", fileId, ...(mode === "copy" ? { requestId: crypto.randomUUID() } : {}) });
      await displayProfileWorkbook(result, mode);
    }
    profileElement("fileManagerModal").style.display = "none";
    profileElement("profileDialog").close();
    closeMobileMenu();
  } catch (error) { alert(profileMessage(error)); }
  finally { hideLoading(); profileState.busy = false; renderProfileState(); }
}
async function saveProfileWorkbook(rows, workbook, onProgress) {
  const workspace = profileState.workspace;
  if (!profileState.user || workspace?.mode !== "copy" || workspace.owner !== profileState.user.id || profileState.busy) throw new Error("SIGN_IN_REQUIRED");
  const generation = profileState.generation;
  const edits = rows.flatMap((row, index) => {
    const previous = window._currentRows[index];
    const fields = ["del_qty", "del_status", "delivery_notes"];
    const values = Object.fromEntries(fields.filter(key => JSON.stringify(row[key] ?? null) !== JSON.stringify(previous[key] ?? null)).map(key => [key, row[key]]));
    if ("del_qty" in values || "del_status" in values) { values.del_qty = row.del_qty ?? ""; values.del_status = row.del_status ?? ""; }
    return Object.keys(values).length ? [{ index, values }] : [];
  });
  if (!edits.length) return workbook;
  onProgress("Saving your profile copy");
  const result = await profileApi({ action: "save", fileId: workspace.fileId, copyRevision: workspace.copyRevision, edits, requestId: crypto.randomUUID() });
  if (generation !== profileState.generation || workspace !== profileState.workspace) throw new Error("SIGN_IN_REQUIRED");
  Object.assign(workspace, { copyRevision: result.copyRevision, pending: result.pending });
  renderProfileState();
  return profileViewWorkbook();
}
async function listProfileFiles() {
  const list = profileElement("savedFiles");
  list.replaceChildren();
  const message = document.createElement("p");
  message.className = "saved-files-empty";
  profileElement("savedFilesAccount").textContent = profileState.user ? `SIGNED IN AS ${profileUsername(profileState.user)}` : "DELIVERY FILES";
  message.textContent = profileState.user ? "Finding your saved copies and team Excel files…" : "Finding team Excel files to view…";
  list.append(message);
  const generation = profileState.generation;
  try {
    const managed = await profileApi({ action: profileState.user ? "list" : "public-list" });
    await loadSharedCartDeliveryNames();
    const legacy = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await sb.storage.from(BUCKET).list("", { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      legacy.push(...data.filter(file => /\.(xlsx|xls|csv)$/i.test(file.name) && !/route[\s_.-]*summary/i.test(file.name)));
      if (data.length < 100) break;
    }
    if (generation !== profileState.generation) return;
    const files = [...managed.files];
    legacy.forEach(file => { if (!files.some(f => f.sourceKey === file.name || f.name === file.name)) files.push({ name: file.name, sourceKey: file.name }); });
    const visible = files.filter(file => activeSavedFilesTab === "all" || cartDeliveryFileNames.has(file.sourceKey || file.name));
    list.replaceChildren();
    if (!visible.length) { message.textContent = activeSavedFilesTab === "all" ? "No team Excel files yet. Upload a route file from the menu to get started." : "No shortcuts yet. Choose All Files to find a team Excel and open your copy."; list.append(message); }
    visible.forEach(file => {
      const card = document.createElement("article"); card.className = "saved-file-card";
      const heading = document.createElement("div"); heading.className = "saved-file-heading";
      const icon = document.createElement("span"); icon.className = "saved-file-icon"; icon.textContent = "XLS"; icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span"); name.className = "saved-file-name"; name.textContent = file.name;
      heading.append(icon, name);
      const detail = document.createElement("p"); detail.className = "profile-file-detail";
      detail.textContent = !profileState.user ? "View the team Excel without signing in. Sign in to work in your own copy." : file.copyId ? file.pending ? `Saved to your account · ${file.pending} ${file.pending === 1 ? "change" : "changes"} waiting to sync` : "Your saved copy is ready to reopen on this device." : "Start your own copy. Your delivery saves stay separate until you sync them.";
      const open = document.createElement("button"); open.className = "saved-file-btn"; open.textContent = !profileState.user ? "View team Excel (read only)" : file.copyId ? "Continue my work" : "Start my own copy";
      open.onclick = () => openProfileFile(file, profileState.user ? "copy" : "original");
      const actions = document.createElement("div"); actions.className = "saved-file-secondary-actions";
      const original = document.createElement("button"); original.textContent = "View team Excel (read only)"; original.onclick = () => openProfileFile(file, "original");
      const organize = document.createElement("button"); const key = file.sourceKey || file.name;
      const included = cartDeliveryFileNames.has(key); organize.textContent = included ? "Remove shortcut" : "Add to Cart Delivery";
      organize.setAttribute("aria-pressed", String(included));
      organize.onclick = async () => {
        organize.disabled = true; const before = new Set(cartDeliveryFileNames);
        if (included) cartDeliveryFileNames.delete(key); else cartDeliveryFileNames.add(key);
        try { await saveCartDeliveryFileNames(); } catch (error) { cartDeliveryFileNames = before; alert(profileMessage(error)); }
        await listFiles();
      };
      if (profileState.user) actions.append(original, organize);
      else { const signIn = document.createElement("button"); signIn.textContent = "Sign in to make changes in my copy"; signIn.onclick = requireProfile; actions.append(signIn); }
      card.append(heading, detail, open, actions); list.append(card);
    });
  } catch (error) { message.textContent = profileMessage(error); list.replaceChildren(message); }
}
function profileCountText(row) {
  return `${deliveredCartCount(row)} of ${cartTotal(row) ?? "?"} carts delivered${row.delivery_notes ? ` · ${row.delivery_notes}` : ""}`;
}
function profileSyncImpact(preview, resolutions = []) {
  const choices = new Map(resolutions.map(choice => [choice.index, choice]));
  const impact = { stops: 0, added: 0, removed: 0, completed: 0, reopened: 0, notes: 0, unknown: 0, unchanged: 0, unresolved: 0, routes: [] };
  const groups = new Map();
  for (const item of preview.changes) {
    const choice = choices.get(item.index);
    if (item.conflict && (!choice || !['original', 'mine', 'count'].includes(choice.choice) || (choice.choice === 'count' &&
      (!Number.isSafeInteger(choice.count) || cartTotal(item.original) === null || choice.count < 0 || choice.count > cartTotal(item.original))))) {
      impact.unresolved++; continue;
    }
    if (item.conflict && choice.choice === 'original') { impact.unchanged++; continue; }
    // Match the sync transaction: apply edited fields over the latest team values.
    const delta = Object.fromEntries(item.fields.map(field => [field, item.mine[field]]));
    if ('del_qty' in delta || 'del_status' in delta) Object.assign(delta, { del_qty: item.mine.del_qty ?? '', del_status: item.mine.del_status ?? '' });
    if (item.conflict && choice.choice === 'count') Object.assign(delta, {
      del_qty: choice.count, del_status: choice.count === cartTotal(item.original) ? 'Delivered' : ''
    });
    const after = { ...item.original, ...delta };
    const changed = ['del_qty', 'del_status', 'delivery_notes'].filter(field => JSON.stringify(after[field] ?? null) !== JSON.stringify(item.original[field] ?? null));
    if (!changed.length) { impact.unchanged++; continue; }
    impact.stops++;
    const route = String(rowRoute(item.original) ?? '').trim() || 'Unassigned';
    const day = String(rowDay(item.original) ?? '').trim();
    const key = JSON.stringify([route, day]);
    if (!groups.has(key)) groups.set(key, { route, day, stops: 0, added: 0, removed: 0 });
    const group = groups.get(key); group.stops++;
    if (changed.includes('delivery_notes')) impact.notes++;
    if (changed.includes('del_qty') || changed.includes('del_status')) {
      if (cartTotal(after) === null) impact.unknown++;
      else {
        const difference = deliveredCartCount(after) - deliveredCartCount(item.original);
        const added = Math.max(0, difference), removed = Math.max(0, -difference);
        impact.added += added; impact.removed += removed; group.added += added; group.removed += removed;
      }
      if (!isDeliveredRow(item.original) && isDeliveredRow(after)) impact.completed++;
      if (isDeliveredRow(item.original) && !isDeliveredRow(after)) impact.reopened++;
    }
  }
  impact.routes = [...groups.values()].sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }) || a.day.localeCompare(b.day, undefined, { numeric: true }));
  return impact;
}
function profileSyncChoices() {
  return [...(profileState.conflictChoices?.values() || [])];
}
function profileHigherCountChoice(item) {
  const notes = row => String(row.delivery_notes ?? '');
  const notesConflict = notes(item.mine) !== notes(item.base) && notes(item.original) !== notes(item.base) && notes(item.mine) !== notes(item.original);
  if (cartTotal(item.original) === null || notesConflict) return null;
  return { index: item.index, choice: 'count', count: Math.max(deliveredCartCount(item.mine), deliveredCartCount(item.original)) };
}
function renderProfileSyncImpact(container, preview, resolutions) {
  const impact = profileSyncImpact(preview, resolutions);
  container.replaceChildren();
  const title = document.createElement('h3'); title.textContent = impact.unresolved ? 'Sync totals so far' : 'What will change in team Excel';
  const metrics = document.createElement('dl'); metrics.className = 'profile-sync-metrics';
  for (const [label, value] of [['Stops updated', impact.stops], ['Carts added to delivered total', impact.added], ['Carts removed from delivered total', impact.removed], ['Stops completed', impact.completed]]) {
    const box = document.createElement('div'), term = document.createElement('dt'), count = document.createElement('dd');
    term.textContent = label; count.textContent = value.toLocaleString(); box.append(term, count); metrics.append(box);
  }
  container.append(title, metrics);
  if (impact.removed || impact.reopened) {
    const warning = document.createElement('p'); warning.className = 'profile-sync-reduction';
    warning.textContent = `Check corrections: this sync removes ${impact.removed} carts from the team's delivered total and returns ${impact.reopened} completed stops to pending. Continue only if these corrections are intentional.`;
    container.append(warning);
  }
  const notes = document.createElement('p');
  notes.textContent = [
    impact.reopened ? `${impact.reopened} completed stops return to pending.` : '',
    impact.notes ? `${impact.notes} stops have note updates.` : '',
    impact.unchanged ? `${impact.unchanged} stops keep the current team Excel values.` : '',
    impact.unknown ? `${impact.unknown} stops have no valid QTY; excluded from cart totals.` : '',
    impact.unresolved ? `${impact.unresolved} conflicts still need a decision and are excluded from these totals.` : 'Totals compare your sync with the current team Excel values.'
  ].filter(Boolean).join(' ');
  container.append(notes);
  if (impact.routes.length) {
    const routes = document.createElement('details'); routes.className = 'profile-explainer';
    const summary = document.createElement('summary'); summary.textContent = `Routes / days affected (${impact.routes.length})`;
    const list = document.createElement('ul');
    for (const group of impact.routes) {
      const line = document.createElement('li'); line.textContent = `Route ${group.route} · ${dayName(Number(group.day)) || (group.day ? `Day ${group.day}` : 'No day')} — ${group.stops} stops · +${group.added} / −${group.removed} carts`;
      list.append(line);
    }
    routes.append(summary, list); container.append(routes);
  }
  return impact;
}
async function reviewProfileSync() {
  if (!requireProfile() || !profileState.workspace) return;
  await profileTask("profileStatus", async () => {
    const preview = await profileApi({ action: "preview", fileId: profileState.workspace.fileId });
    while (preview.changes.length < preview.pending) {
      const page = await profileApi({ action: "preview", fileId: preview.fileId, offset: preview.changes.length,
        copyRevision: preview.copyRevision, masterRevision: preview.masterRevision });
      if (!page.changes.length) throw new Error("STALE_VERSION");
      preview.changes.push(...page.changes);
    }
    profileState.preview = preview; profileState.syncRequest = null; profileState.shareConfirmation = null;
    profileState.conflictChoices = new Map();
    const conflicts = preview.changes.filter(item => item.conflict).length;
    profileElement("profileSyncSummary").textContent = preview.name;
    profileElement("profileSyncHelp").textContent = conflicts
      ? `${preview.changes.length} changed stops to sync. ${conflicts} have different changes that need a choice. Resolve them together below, then adjust any exceptions.`
      : preview.changes.length ? `${preview.changes.length} saved ${preview.changes.length === 1 ? "stop" : "stops"} ready to sync. No conflicts — you can confirm the totals without reviewing each stop.`
      : "You have no changes waiting to sync. Update your copy to get the team's latest deliveries.";
    profileElement("profileSyncStatus").textContent = "";
    const list = profileElement("profileSyncChanges"); list.replaceChildren();
    profileElement('profileSyncConflictTools').replaceChildren();
    const refreshImpact = () => {
      const impact = renderProfileSyncImpact(profileElement('profileSyncImpact'), preview, profileSyncChoices());
      if (!profileState.syncRequest) profileElement('profileSyncStatus').textContent = '';
      const progress = profileElement('profileConflictProgress');
      if (progress) progress.textContent = `${conflicts - impact.unresolved} of ${conflicts} conflicts resolved. ${impact.unresolved} left to choose.`;
    };
    const createChangeCard = item => {
      const card = document.createElement("article"); card.className = "profile-change";
      const title = document.createElement("strong"); title.textContent = `${formatStopAddress(item.mine)} · Bin ${item.mine.BINNO ?? "—"} · Record ${item.index + 1}`;
      card.append(title);
      [["Your copy started with", item.base], ["Team Excel now", item.original], ["Your saved changes", item.mine]].forEach(([label, row]) => {
        const line = document.createElement("div"); line.className = "profile-comparison";
        const heading = document.createElement("span"); heading.textContent = label;
        const value = document.createElement("strong"); value.textContent = profileCountText(row);
        line.append(heading, value); card.append(line);
      });
      if (item.conflict) {
        card.classList.add("profile-conflict");
        const label = document.createElement("label"); label.textContent = "The team changed this stop too. Which values should everyone use?";
        const select = document.createElement("select"); select.dataset.conflictIndex = item.index; select.setAttribute("aria-label", `Resolve record ${item.index + 1}`);
        [["", "Choose which values to keep"], ["original", "Keep the team's values"], ["mine", "Use my changes"], ...(cartTotal(item.original) !== null ? [["count", "Enter the correct total delivered"]] : [])].forEach(([value, text]) => select.add(new Option(text, value)));
        const countLabel = document.createElement("label"); countLabel.textContent = "Final total delivered (all teams combined)"; countLabel.hidden = true;
        const input = document.createElement("input"); Object.assign(input, { type: "number", inputMode: "numeric", min: "0", max: String(cartTotal(item.original)), step: "1" }); input.dataset.conflictCount = item.index;
        const saved = profileState.conflictChoices.get(item.index);
        select.value = saved?.choice || ''; input.value = saved?.count ?? ''; countLabel.hidden = select.value !== 'count';
        select.disabled = input.disabled = Boolean(profileState.syncRequest);
        const refresh = () => {
          if (profileState.busy || profileState.syncRequest) return;
          profileState.conflictChoices.set(item.index, { index: item.index, choice: select.value, ...(select.value === 'count' ? { count: input.value.trim() ? Number(input.value) : null } : {}) });
          refreshImpact();
        };
        countLabel.append(input); select.onchange = () => { countLabel.hidden = select.value !== "count"; refresh(); };
        input.oninput = refresh;
        label.append(select); card.append(label, countLabel);
      }
      return card;
    };
    if (conflicts) {
      const items = preview.changes.filter(item => item.conflict);
      const bulk = document.createElement('section'); bulk.className = 'profile-conflict-tools';
      const heading = document.createElement('h3'); heading.textContent = 'Resolve conflicts together';
      const label = document.createElement('label'); label.textContent = 'Choose a rule for this sync';
      const rule = document.createElement('select'); rule.id = 'profileConflictRule';
      [['', 'Choose a rule'], ['higher', 'Keep the higher delivered total'], ['original', "Keep the team’s values"], ['mine', 'Use my changes']].forEach(([value, text]) => rule.add(new Option(text, value)));
      label.append(rule);
      const explanation = document.createElement('p'); explanation.id = 'profileConflictRuleHelp';
      rule.setAttribute('aria-describedby', explanation.id);
      const apply = document.createElement('button'); apply.type = 'button'; apply.id = 'profileApplyConflicts'; apply.textContent = `Apply to all ${conflicts} conflicts`; apply.disabled = true;
      rule.onchange = () => {
        apply.disabled = !rule.value || Boolean(profileState.syncRequest);
        explanation.textContent = rule.value === 'higher'
          ? 'Keeps the larger reported total; never adds the two counts. Differing notes and unknown quantities still need a choice. Use a correction instead if the larger count is wrong.'
          : rule.value === 'original' ? 'Keeps the current team values for every conflicting stop, discarding your changes at those stops. Other stops still sync.'
          : rule.value === 'mine' ? 'Applies your changed fields at every conflicting stop. This can lower delivered counts or replace team notes. Check the totals before syncing.'
          : 'Matching delivery totals agree automatically. Unrelated note and delivery changes merge. Different totals are never added together.';
      };
      rule.onchange();
      const progress = document.createElement('p'); progress.id = 'profileConflictProgress'; progress.setAttribute('role', 'status');
      const hint = document.createElement('p'); hint.textContent = 'Applying a rule replaces earlier choices for eligible conflicts, including those not shown below. You can adjust exceptions. Nothing is synced until the final confirmation.';
      bulk.append(heading, label, explanation, apply, progress, hint); profileElement('profileSyncConflictTools').append(bulk);
      const details = document.createElement('details'); details.className = 'profile-explainer'; details.id = 'profileConflictDetails';
      details.open = conflicts <= 10;
      const summary = document.createElement('summary'); summary.textContent = `Review individual conflicts (${conflicts})`;
      const cards = document.createElement('div');
      const pager = document.createElement('div'); pager.className = 'profile-conflict-pager';
      const previous = document.createElement('button'), next = document.createElement('button'), page = document.createElement('span');
      previous.type = next.type = 'button'; previous.textContent = 'Previous'; next.textContent = 'Next';
      let offset = 0;
      const renderPage = () => {
        cards.replaceChildren(...items.slice(offset, offset + 20).map(createChangeCard));
        previous.disabled = offset === 0; next.disabled = offset + 20 >= conflicts;
        previous.dataset.pageDisabled = String(previous.disabled); next.dataset.pageDisabled = String(next.disabled);
        page.textContent = `${offset + 1}–${Math.min(offset + 20, conflicts)} of ${conflicts}`;
      };
      previous.onclick = () => { offset -= 20; renderPage(); summary.scrollIntoView({ block: 'start' }); };
      next.onclick = () => { offset += 20; renderPage(); summary.scrollIntoView({ block: 'start' }); };
      pager.append(previous, page, next); details.append(summary, cards, pager); list.append(details);
      details.ontoggle = () => { if (details.open) renderPage(); };
      if (details.open) renderPage();
      apply.onclick = () => {
        if (!rule.value || profileState.busy || profileState.syncRequest) return;
        for (const item of items) {
          const choice = rule.value === 'higher' ? profileHigherCountChoice(item) : { index: item.index, choice: rule.value };
          if (choice) profileState.conflictChoices.set(item.index, choice);
        }
        if (details.open) renderPage();
        refreshImpact();
      };
    }
    const ordinary = preview.changes.filter(item => !item.conflict);
    if (ordinary.length) {
      const details = document.createElement('details'); details.className = 'profile-explainer'; details.id = 'profileSyncDetails';
      const summary = document.createElement('summary'); summary.textContent = `View individual stops (${ordinary.length}) · optional`;
      const cards = document.createElement('div');
      const more = document.createElement('button'); more.type = 'button'; more.textContent = 'Show more stops';
      let offset = 0;
      const append = () => {
        ordinary.slice(offset, offset + 50).forEach(item => cards.append(createChangeCard(item)));
        offset += 50; more.hidden = offset >= ordinary.length;
      };
      details.ontoggle = () => { if (details.open && !offset) append(); };
      more.onclick = append;
      details.append(summary, cards, more); list.append(details);
    }
    refreshImpact();
    profileElement('profileSyncImpact').hidden = !preview.changes.length;
    list.hidden = !preview.changes.length;
    profileElement("confirmProfileSyncBtn").textContent = preview.changes.length ? "Next: confirm sync" : "Next: confirm copy update";
    profileElement("profileStatus").textContent = "";
    profileElement("profileDialog").close(); profileElement("profileSyncDialog").showModal();
  });
}
async function confirmProfileSync() {
  const preview = profileState.preview;
  if (!preview || !requireProfile() || profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  try {
    let request = profileState.syncRequest;
    if (!request) {
      const resolutions = preview.changes.filter(item => item.conflict).map(item => {
        const resolution = profileState.conflictChoices.get(item.index);
        const choice = resolution?.choice;
        if (!choice) throw new Error("UNRESOLVED_CONFLICT");
        if (choice === "count" && (!Number.isSafeInteger(resolution.count) || cartTotal(item.original) === null || resolution.count < 0 || resolution.count > cartTotal(item.original))) throw new Error("INVALID_QUANTITY");
        return { ...resolution };
      });
      request = { action: "sync", fileId: preview.fileId, copyRevision: preview.copyRevision,
        masterRevision: preview.masterRevision, resolutions, requestId: crypto.randomUUID() };
    }
    profileState.shareConfirmation = { request, preview, generation: profileState.generation, owner: profileState.user.id };
    const sharing = preview.changes.length > 0;
    profileElement("profileShareTitle").textContent = sharing ? "Sync to team Excel?" : "Update your copy?";
    profileElement("profileShareAccount").textContent = profileUsername(profileState.user);
    profileElement("profileShareFile").textContent = preview.name;
    const impact = renderProfileSyncImpact(profileElement('profileShareImpact'), preview, request.resolutions);
    profileElement('profileShareImpact').hidden = !sharing;
    profileElement("profileShareCount").textContent = `${impact.stops} stops updated · ${impact.unresolved} unresolved conflicts`;
    profileElement("profileShareEffect").textContent = sharing
      ? "This updates team Excel with the totals above and your conflict choices. Your copy will also receive the latest team Excel updates."
      : "This brings the team's latest saved deliveries into your copy. You have no changes to send to the team Excel.";
    profileElement("profileShareAcknowledgement").textContent = sharing ? "I want to sync these totals and conflict choices to team Excel." : "I want to update my copy with the team's latest saved work.";
    profileElement("commitProfileShareBtn").textContent = sharing ? "Confirm sync to team Excel" : "Confirm & update my copy";
    profileElement("cancelProfileShareBtn").textContent = sharing ? "Go back without syncing" : "Go back without updating";
    profileElement("profileShareAcknowledged").checked = false;
    profileElement("profileShareStatus").textContent = "";
    profileElement("profileSyncStatus").textContent = "";
    renderProfileState();
    profileElement("profileSyncDialog").close(); profileElement("profileShareDialog").showModal();
  } catch (error) {
    profileElement("profileSyncStatus").textContent = profileMessage(error);
    profileElement("profileSyncStatus").dataset.state = "error";
  }
}
async function commitProfileShare() {
  const confirmation = profileState.shareConfirmation;
  if (!confirmation || !profileElement("profileShareDialog").open || !profileElement("profileShareAcknowledged").checked || profileState.busy) return;
  const { preview, request, generation, owner } = confirmation;
  if (generation !== profileState.generation || owner !== profileState.user?.id || preview !== profileState.preview || preview.fileId !== profileState.workspace?.fileId) return;
  await profileTask("profileShareStatus", async () => {
    profileElement("profileShareStatus").textContent = "Confirming with the server…";
    profileState.syncRequest = request;
    // Retain this request ID after an uncertain response so retry cannot apply it twice.
    const result = await profileApi(request);
    await displayProfileWorkbook(result);
    profileElement("profileShareDialog").close(); profileElement("profileDialog").showModal();
    profileElement("profileStatus").textContent = preview.changes.length ? "Synced to team Excel. Your copy now includes the team's latest updates." : "Your copy now includes the team's latest updates. You're ready to continue.";
  });
  profileElement("profileShareAcknowledged").checked = false;
  if (profileElement("profileShareDialog").open) profileElement("profileShareStatus").textContent += " A retry uses the same reviewed choices. Reopen your saved copy to check what was confirmed.";
  renderProfileState();
}
async function showProfileHistory(more = false) {
  const workspace = profileState.workspace;
  if (!workspace || profileState.busy) return;
  profileState.busy = true;
  const button = profileElement("moreProfileHistoryBtn"); button.disabled = true;
  profileElement("profileDialog").close();
  if (!profileElement("profileHistoryDialog").open) profileElement("profileHistoryDialog").showModal();
  const list = profileElement("profileHistoryEntries"); if (!more) list.replaceChildren();
  profileElement("profileHistoryStatus").textContent = `Loading history for ${workspace.name}…`;
  try {
    const { history } = await profileApi({ action: "history", fileId: workspace.fileId, offset: list.children.length });
    history.forEach(entry => {
      const card = document.createElement("details"); card.className = "profile-change";
      const summary = document.createElement("summary"); summary.textContent = `${entry.profile_name} synced ${entry.change_count} ${entry.change_count === 1 ? "change" : "changes"} · ${new Date(entry.created_at).toLocaleString()}`;
      const version = document.createElement("p"); version.textContent = entry.resolution_count ? `${entry.resolution_count} conflicting team changes were reviewed before syncing.` : "No conflicting team changes needed review.";
      card.append(summary, version);
      const detail = document.createElement("div");
      const load = document.createElement("button"); load.textContent = "Show changes";
      let offset = 0;
      const loadPage = async () => {
        if (load.disabled || load.hidden) return;
        load.disabled = true;
        try {
          const page = await profileApi({ action: "history-changes", fileId: workspace.fileId, eventId: entry.id, offset });
          page.changes.forEach(change => {
            const line = document.createElement("p"); line.textContent = `${change.address || "Record " + (change.index + 1)} · Bin ${change.bin || "—"}: ${change.fields.map(field => `${({ del_qty: "Carts delivered", del_status: "Status", delivery_notes: "Note" })[field.field] || field.field}: ${field.before === "" || field.before == null ? "blank" : field.before} → ${field.after === "" || field.after == null ? "blank" : field.after}`).join("; ")}`; detail.append(line);
          });
          page.resolutions.forEach(resolution => { const line = document.createElement("p"); line.textContent = `Record ${resolution.index + 1}: ${resolution.choice === "count" ? `final delivered total ${resolution.count}` : resolution.choice === "mine" ? "used this person's changes" : "kept the team's values"}`; detail.append(line); });
          offset += 250;
          load.textContent = "Show more changes";
          load.hidden = offset >= Math.max(entry.change_count, entry.resolution_count);
        } catch (error) { load.textContent = profileMessage(error) + " Tap to retry."; }
        finally { load.disabled = false; }
      };
      load.onclick = loadPage;
      card.ontoggle = () => { if (card.open && !offset) loadPage(); };
      card.append(detail, load);
      list.append(card);
    });
    button.hidden = history.length < 25;
    profileElement("profileHistoryStatus").textContent = list.children.length ? `${workspace.name} · Most recent first. Tap an entry to see what changed.` : "No changes have been synced to team Excel yet. Delivery saves stay in each person's copy until they sync them.";
  } catch (error) { profileElement("profileHistoryStatus").textContent = profileMessage(error); }
  finally { button.disabled = false; profileState.busy = false; renderProfileState(); }
}
function setupHelp() {
  const dialog = document.getElementById('helpDialog'), el = id => document.getElementById(id);
  const steps = [
    { team: 0, mine: 0, other: 0, arrow: '↓', action: 'Open your own copy', mineNote: 'Ready to work', otherNote: 'Their own copy',
      title: 'One shared starting point', text: 'Each profile works in its own copy.', next: 'Next: save →' },
    { team: 0, mine: 1, other: 0, arrow: '‖', action: 'Not shared yet', mineNote: 'Saved · waiting to sync', otherNote: 'Unchanged',
      title: 'Saved in your copy only', text: '1 cart delivered. Team still sees 0.', next: 'Next: sync →' },
    { team: 1, mine: 1, other: 0, arrow: '↑', action: 'Review → confirm → share', mineNote: 'Up to date', otherNote: 'Needs team update',
      title: 'Team file now shows your delivery', text: 'Your copy also receives the latest team updates.', next: 'Next: teammate →' },
    { team: 1, mine: 1, other: 1, arrow: '↓', action: 'Teammate checks for team updates', mineNote: 'Shared', otherNote: 'Updated',
      title: 'Now both copies see it', text: 'Teammate has unsynced work? They review and sync instead.', next: 'Replay ↺' }
  ];
  const showCarts = (id, count) => {
    [...el(id).children].forEach((cart, index) => {
      cart.classList.toggle('is-delivered', index < count);
      cart.querySelector('b').textContent = index < count ? '✓' : '·';
    });
  };
  const syncExamples = {
    same: { mine: 1, team: 1, result: '✓ Agree: keep 1 delivered', reason: 'Same report twice ≠ 2 carts.' },
    different: { mine: 1, team: 2, result: 'Choose the correct total', reason: '1 and 2 are never automatically added to make 3.' },
    correction: { mine: 1, team: 3, result: 'Check before reducing 3 → 1', reason: 'Using your count removes 2 delivered carts and reopens this stop.' }
  };
  function showSyncExample(name) {
    const example = syncExamples[name];
    showCarts('helpSyncMineCarts', example.mine); showCarts('helpSyncTeamCarts', example.team);
    el('helpSyncMine').textContent = `${example.mine} / 3`;
    el('helpSyncTeam').textContent = `${example.team} / 3`;
    el('helpSyncResult').textContent = example.result; el('helpSyncReason').textContent = example.reason;
    el('helpSyncExample').dataset.example = name;
    dialog.querySelectorAll('[data-help-sync]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.helpSync === name)));
  }
  let current = 0;
  function showStep(index) {
    current = index;
    const step = steps[index];
    el('helpTeamCount').textContent = `${step.team} / 2 delivered`;
    el('helpMyCount').textContent = `${step.mine} / 2 delivered`;
    el('helpOtherCount').textContent = `${step.other} / 2 delivered`;
    showCarts('helpTeamCarts', step.team); showCarts('helpMyCarts', step.mine); showCarts('helpOtherCarts', step.other);
    for (const [id,value] of Object.entries({ helpMyNote: step.mineNote, helpOtherNote: step.otherNote, helpFlowArrow: step.arrow,
      helpFlowAction: step.action, helpStepTitle: step.title, helpStepText: step.text, helpNextStep: step.next, helpStepCount: `${index + 1} / 4` })) el(id).textContent = value;
    dialog.querySelectorAll('[data-help-step]').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.helpStep) === index)));
  }
  el('openHelpBtn').onclick = () => {
    showStep(0); showSyncExample('same'); dialog.querySelectorAll('details').forEach(details => { details.open = false; });
    dialog.showModal(); el('helpDialog').querySelector('.help-content').scrollTop = 0; el('closeHelpBtn').focus({ preventScroll: true });
  };
  const close = () => dialog.close();
  el('closeHelpBtn').onclick = el('helpBackToMap').onclick = close;
  dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
  dialog.addEventListener('close',() => el('openHelpBtn').focus({ preventScroll: true }));
  dialog.querySelectorAll('[data-help-step]').forEach(button => { button.onclick = () => showStep(Number(button.dataset.helpStep)); });
  dialog.querySelectorAll('[data-help-sync]').forEach(button => { button.onclick = () => showSyncExample(button.dataset.helpSync); });
  el('helpNextStep').onclick = () => showStep((current + 1) % steps.length);
}

function setupProfileAdmin() {
  const el = id => document.getElementById(id), dialog = el('adminDialog');
  let client = null, user = null, busy = false, screen = 'prompt', directory = null, editing = null;
  const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
  const status = value => { el('adminStatus').textContent = value; };
  const errorMessage = error => {
    const message = error.message || '';
    if (/ADMIN_REQUIRED/.test(message)) return 'This account is not an administrator.';
    if (/SIGN_IN_REQUIRED|PROFILE_DISABLED/.test(message)) return 'Admin sign-in has expired or this account is disabled. Sign out of admin and sign in again.';
    if (/ADMIN_PROTECTED/.test(message)) return 'The administrator account cannot be renamed, disabled or removed here.';
    if (/PROFILE_HAS_AREAS/.test(message)) return 'Reassign this profile’s work areas on the team Excel before removing the profile.';
    if (/REMOVE_INCOMPLETE/.test(message)) return 'Sign-in is disabled, but removal was not confirmed. Refresh the list before trying again.';
    if (/INVALID_PASSWORD|weak_password/.test(message)) return 'Use at least 6 characters for the new password.';
    if (/NAME_EXISTS|already.*registered/i.test(message)) return 'That username is already in use. Choose another.';
    if (/INVALID_REMOVE_CONFIRMATION/.test(message)) return 'Type the exact username to confirm removal.';
    if (/Invalid login credentials/i.test(message)) return 'The admin username or password is incorrect.';
    if (/INVALID_USERNAME/.test(message)) return 'Use 3–30 letters, numbers, underscores or hyphens for the username.';
    if (/INVALID_PROFILE_COLOR/.test(message)) return 'Choose a valid profile color.';
    return 'Could not confirm the change. Refresh the profiles to check what was saved before trying again.';
  };
  function render() {
    el('adminPrompt').hidden = screen !== 'prompt'; el('adminLoginForm').hidden = screen !== 'login';
    el('adminDashboard').hidden = screen !== 'list'; el('adminEditForm').hidden = screen !== 'edit';
    dialog.querySelectorAll('button,input').forEach(input => { input.disabled = busy; });
    el('adminEditUsername').disabled = busy || Boolean(editing?.isAdmin);
    el('adminEditColor').disabled = busy || !el('adminUseColor').checked;
    el('adminRemoveBtn').disabled = busy || !editing || editing.isAdmin || el('adminRemoveConfirm').value !== editing.username || editing.areas > 0;
    dialog.setAttribute('aria-busy',String(busy));
    if (screen !== 'list') return;
    const profiles = directory?.profiles || [], query = el('adminSearch').value.trim().toLowerCase();
    const list = el('adminProfiles'); list.replaceChildren();
    const shown = profiles.filter(profile => profile.username.includes(query));
    el('adminCount').textContent = `${shown.length} of ${profiles.length} profiles · ${profiles.filter(profile => profile.disabled).length} disabled`;
    if (!shown.length) list.append(text('p','No profiles match this search.'));
    for (const profile of shown) {
      const card = document.createElement('article'); card.className = 'admin-profile-card';
      const name = text('strong',profile.username);
      if (/^#[0-9a-f]{6}$/i.test(profile.color || '')) {
        const swatch = text('i',''); swatch.className = 'profile-color-swatch'; swatch.style.backgroundColor = profile.color;
        swatch.setAttribute('aria-label',`Profile color ${profile.color}`); name.prepend(swatch);
      }
      card.append(name,text('span',profile.isAdmin ? 'Administrator' : profile.disabled ? 'Sign-in disabled' : 'Active'));
      card.append(text('p',`${profile.copies} saved copies · ${profile.pending} unsynced stops · ${profile.areas} work areas`));
      card.append(text('small',`Created ${profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'date unavailable'} · Last sign-in: ${profile.lastSignInAt ? new Date(profile.lastSignInAt).toLocaleString() : 'Never'}`));
      const button = text('button',profile.isAdmin ? 'Change admin password' : 'Manage profile'); button.type = 'button'; button.disabled = busy;
      button.onclick = () => edit(profile); card.append(button); list.append(card);
    }
    const events = el('adminEvents'); events.replaceChildren();
    for (const event of directory?.events || []) events.append(text('li',`${event.details.username} · ${event.action}${event.details.passwordChanged ? ' · password set' : ''} · ${new Date(event.created_at).toLocaleString()}`));
    if (!events.children.length) events.append(text('li','No admin changes yet.'));
  }
  async function api(body) {
    const { data: session, error } = await client.auth.getSession();
    if (error || !session.session) throw new Error('SIGN_IN_REQUIRED');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/profile-workbooks`, {
      method: 'POST', headers: { 'Content-Type':'application/json', apikey:SUPABASE_KEY, Authorization:`Bearer ${session.session.access_token}` }, body:JSON.stringify(body)
    });
    const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || 'REQUEST_FAILED');
    return result;
  }
  async function reload() { directory = await api({action:'admin-list'}); }
  async function task(action) {
    if (busy) return;
    busy = true; status('Working…'); render();
    try { await action(); }
    catch (error) { status(errorMessage(error)); }
    finally { busy = false; render(); }
  }
  async function refreshAfterChange(message) {
    editing = null; screen = 'list'; el('adminEditPassword').value = ''; el('adminRemoveConfirm').value = '';
    try { await reload(); status(message); }
    catch { directory = null; status(`${message} Refresh profiles to load the latest list.`); }
    workAreas?.refresh();
  }
  function edit(profile = null) {
    editing = profile; screen = 'edit'; status('');
    el('adminEditContext').textContent = profile ? `Manage ${profile.username}. Changes apply to this profile on every device.` : 'Create a delivery profile. Share its username and password with the person who will use it.';
    el('adminEditUsername').value = profile?.username || ''; el('adminEditPassword').value = ''; el('adminEditPassword').required = !profile;
    el('adminUseColor').checked = !profile || Boolean(profile.color);
    el('adminEditColor').value = profile?.color || '#2563eb';
    el('adminPasswordHelp').textContent = profile ? 'Leave blank to keep the password, or enter at least 6 characters to reset it. Existing passwords cannot be viewed.' : 'At least 6 characters. No other password rules.';
    el('adminAccessControls').hidden = !profile || profile.isAdmin;
    el('adminAccessHelp').textContent = profile ? `${profile.disabled ? 'Sign-in is disabled.' : 'Sign-in is enabled.'} Disabling access preserves their saved work.${profile.areas ? ` Reassign ${profile.areas} work areas before removing this account.` : ''}` : '';
    el('adminToggleAccessBtn').textContent = profile?.disabled ? 'Enable sign-in' : 'Disable sign-in';
    el('adminRemoveConfirm').value = ''; dialog.querySelector('.admin-remove').open = false;
    render(); dialog.scrollTop = 0; el(profile?.isAdmin ? 'adminEditPassword' : 'adminEditUsername').focus();
  }
  function close() { if (!busy) { el('adminPassword').value = ''; el('adminEditPassword').value = ''; editing = null; dialog.close(); } }
  el('openAdminBtn').onclick = () => { if (workAreas?.mapActive || deliverySaveInProgress || profileState.busy) return; screen = user ? 'list' : 'prompt'; status(''); render(); dialog.showModal(); if (user) task(async()=>{await reload();status('');}); };
  el('closeAdminBtn').onclick = el('adminDismissBtn').onclick = close;
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  el('adminProceedBtn').onclick = () => {screen='login';render();el('adminPassword').focus();};
  el('adminLoginForm').onsubmit = event => {
    event.preventDefault(); if (!el('adminLoginForm').reportValidity()) return;
    task(async()=>{
      client ||= supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'cartdelivery-admin-session'}});
      const {data,error} = await client.auth.signInWithPassword({email:`${el('adminUsername').value.trim().toLowerCase()}@profiles.cartdelivery.invalid`,password:el('adminPassword').value});
      el('adminPassword').value = '';
      if (error) throw error;
      try { await reload(); }
      catch (failure) { await client.auth.signOut({scope:'local'}); throw failure; }
      user = data.user; screen='list';status('Signed in as administrator. Your delivery profile is unchanged.');
    });
  };
  el('adminSignOutBtn').onclick = () => task(async()=>{const {error}=await client.auth.signOut({scope:'local'});if(error) throw error;user=null;directory=null;editing=null;screen='prompt';status('Signed out of admin.');});
  el('adminRefreshBtn').onclick = () => task(async()=>{await reload();status('Profiles refreshed.');});
  el('adminNewBtn').onclick = () => edit();
  el('adminSearch').oninput = render;
  el('adminUseColor').onchange = render;
  el('adminCancelEditBtn').onclick = () => {editing=null;el('adminEditPassword').value='';screen='list';status('');render();};
  el('adminRemoveConfirm').oninput = render;
  el('adminEditForm').onsubmit = event => {
    event.preventDefault(); if (!el('adminEditForm').reportValidity()) return;
    const body = {action:'admin-save',userId:editing?.id,username:el('adminEditUsername').value,password:el('adminEditPassword').value,
      color:el('adminUseColor').checked ? el('adminEditColor').value : null};
    task(async()=>{await api(body);await refreshAfterChange('Profile saved.');});
  };
  el('adminToggleAccessBtn').onclick = () => {
    if (!editing || editing.isAdmin || !confirm(`${editing.disabled ? 'Enable' : 'Disable'} sign-in for ${editing.username}?`)) return;
    task(async()=>{await api({action:'admin-status',userId:editing.id,disabled:!editing.disabled});await refreshAfterChange('Account access updated.');});
  };
  el('adminRemoveBtn').onclick = () => {
    if (!editing || editing.isAdmin || editing.areas || el('adminRemoveConfirm').value !== editing.username) return;
    task(async()=>{await api({action:'admin-remove',userId:editing.id,confirmUsername:el('adminRemoveConfirm').value});await refreshAfterChange('Profile login removed. Delivery records and history were kept.');});
  };
}

function setupDeliveryProfiles() {
  setupRouteContext();
  profileElement("profileWorkspaceBtn").onclick = () => { renderProfileState(); profileElement("profileDialog").showModal(); };
  [["closeProfileBtn", "profileDialog"], ["closeProfileSyncBtn", "profileSyncDialog"], ["closeProfileHistoryBtn", "profileHistoryDialog"]].forEach(([button, dialog]) => {
    const close = () => {
      if (profileState.busy) return;
      profileElement(dialog).close();
      if (dialog !== "profileDialog") { renderProfileState(); profileElement("profileDialog").showModal(); }
    };
    profileElement(button).onclick = close;
    profileElement(dialog).addEventListener("cancel", event => { event.preventDefault(); close(); });
  });
  async function authenticate(create) {
    if (!profileElement("profileAuthForm").reportValidity()) return;
    await profileTask("profileStatus", async () => {
      const username = profileElement("profileUsername").value.trim().toLowerCase();
      const credentials = { email: `${username}@profiles.cartdelivery.invalid`, password: profileElement("profilePassword").value };
      const { data, error } = create ? await sb.auth.signUp(credentials) : await sb.auth.signInWithPassword(credentials);
      if (error) throw error;
      if (!data.session) throw new Error("SETUP_REQUIRED");
      profileState.user = data.user; profileElement("profilePassword").value = "";
      profileElement("profilePassword").type = "password";
      profileElement("profileShowPassword").textContent = "Show";
      profileElement("profileShowPassword").setAttribute("aria-label", "Show password");
      profileElement("profileShowPassword").setAttribute("aria-pressed", "false");
      profileElement("profileStatus").textContent = create ? "Account created. Choose a file to start your own copy." : "You're signed in. Choose a file to pick up your saved work.";
    });
    if (teamUploadState.resume && profileState.user) {
      teamUploadState.resume = false;
      openTeamUpload();
    }
  }
  profileElement("profileAuthForm").onsubmit = event => { event.preventDefault(); authenticate(profileState.authMode === "create"); };
  profileElement("profileSignInMode").onclick = () => setProfileAuthMode("signin");
  profileElement("profileCreateMode").onclick = () => setProfileAuthMode("create");
  profileElement("profileShowPassword").onclick = () => {
    const input = profileElement("profilePassword"), button = profileElement("profileShowPassword");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.setAttribute("aria-pressed", String(show));
  };
  profileElement("signOutProfileBtn").onclick = async () => {
    let signedOut = false;
    await profileTask("profileStatus", async () => {
      const { error } = await sb.auth.signOut(); if (error) throw error;
      signedOut = true;
    });
    if (signedOut) {
      setProfileAuthMode("signin");
      profileElement("profileStatus").textContent = "Signed out. Your saved copies will be here when you sign in again.";
    }
  };
  profileElement("profileChooseFileBtn").onclick = () => { profileElement("profileDialog").close(); profileElement("openFileManagerBtn").click(); };
  profileElement("profileContinueBtn").onclick = () => { profileElement("profileDialog").close(); closeMobileMenu(); };
  profileElement('profileResumeBtn').onclick = () => { const view = rememberedDeliveryView(); if (view) openProfileFile(view); };
  map.on('moveend', () => rememberDeliveryView());
  window.addEventListener('pagehide', () => rememberDeliveryView());
  profileElement("profileReloadCopyBtn").onclick = () => openProfileFile(profileState.workspace);
  profileElement("profileReviewBtn").onclick = reviewProfileSync;
  profileElement("confirmProfileSyncBtn").onclick = confirmProfileSync;
  profileElement("profileShareAcknowledged").onchange = renderProfileState;
  profileElement("commitProfileShareBtn").onclick = commitProfileShare;
  const cancelShare = () => {
    if (profileState.busy) return;
    profileState.shareConfirmation = null;
    profileElement("profileShareAcknowledged").checked = false;
    profileElement("profileShareDialog").close();
    if (profileState.preview) {
      if (profileState.syncRequest) profileElement("profileSyncStatus").textContent = "The last attempt could not be confirmed. Retry keeps the same choices. Return to your profile and reload your saved copy to check what was saved.";
      profileElement("profileSyncDialog").showModal();
    }
    renderProfileState();
  };
  profileElement("cancelProfileShareBtn").onclick = cancelShare;
  profileElement("profileShareDialog").addEventListener("cancel", event => { event.preventDefault(); cancelShare(); });
  profileElement("profileHistoryBtn").onclick = () => showProfileHistory();
  profileElement("moreProfileHistoryBtn").onclick = () => showProfileHistory(true);
  sb.auth.onAuthStateChange((_event, session) => {
    // Never await other Supabase calls from inside the auth callback.
    setTimeout(() => {
      const user = session?.user || null;
      if (profileState.user?.id !== user?.id) {
        teamUploadState.result = null; teamUploadState.added = false;
        if (profileState.user) {
          resetTeamMapping();
          teamUploadState.file = null; teamUploadState.resume = false;
          profileElement('teamUploadDialog').close();
        }
        profileState.generation++;
        if (profileState.workspace?.mode !== "original") {
          profileState.workspace = null;
          profileElement("resetMapBtn").click(); window._currentRows = null; window._currentWorkbook = null; window._currentFilePath = null;
        }
        profileState.preview = null; profileState.syncRequest = null; profileState.shareConfirmation = null;
        profileElement("profileShareAcknowledged").checked = false;
        ["profileSyncDialog", "profileShareDialog", "profileHistoryDialog"].forEach(id => profileElement(id).close());
      }
      profileState.user = user;
      renderProfileState();
      if (_event === 'INITIAL_SESSION' && user && !profileState.workspace && rememberedDeliveryView()) openProfileFile(rememberedDeliveryView());
    }, 0);
  });
  renderProfileState();
}


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
function syncSavedFilesGuide() {
  const loaded = Boolean(window._currentWorkbook);
  document.getElementById("savedFilesGuide").hidden = loaded;
  document.getElementById("openFileManagerBtn").classList.toggle("attention", !loaded);
}

syncSavedFilesGuide();


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

// ===== OPTIONAL CITY LIMITS (VIEWPORT POLYGONS + CITY NAME TILES) =====
const CITY_LIMITS_MIN_ZOOM = 9;
const CITY_LIMITS_WMS = "https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Current/MapServer/WMSServer";
const CITY_LIMITS_QUERY = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/28/query";
const CITY_LIMITS_MAX_FEATURES = 80;
const cityLimitsToggle = document.getElementById("cityLimitsToggle");
const cityLimitsStatus = document.getElementById("cityLimitsStatus");
const cityLimitsPane = map.createPane("cityLimitsPane");
cityLimitsPane.style.zIndex = "280";
cityLimitsPane.style.pointerEvents = "none";
const cityLimitsLabelPane = map.createPane("cityLimitsLabelPane");
cityLimitsLabelPane.style.zIndex = "281";
cityLimitsLabelPane.style.pointerEvents = "none";
const cityLimitsRenderer = L.canvas({ pane: "cityLimitsPane", padding: 0.2 });
const cityLimitsHalo = L.geoJSON(null, {
  pane: "cityLimitsPane", renderer: cityLimitsRenderer, interactive: false,
  style: { color: "#ffffff", weight: 7, opacity: 0.95, fill: false, lineJoin: "round" }
});
const cityLimitsPolygons = L.geoJSON(null, {
  pane: "cityLimitsPane", renderer: cityLimitsRenderer, interactive: false,
  style: { color: "#c52267", weight: 3.5, opacity: 1, fillColor: "#ed4089", fillOpacity: 0.14, fillRule: "evenodd", lineJoin: "round" }
});
const cityLimitsLabels = L.tileLayer.wms(CITY_LIMITS_WMS, {
  ...tileOptions,
  pane: "cityLimitsLabelPane",
  className: "city-limits-tiles",
  layers: "48", // City names only; polygons below provide the stronger outline and fill.
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
const cityLimitsLayer = L.layerGroup([cityLimitsHalo, cityLimitsPolygons, cityLimitsLabels]);
let cityLimitsLoadFailed = false;
let cityLimitsGeometryStatus = "";
let cityLimitsRequest = null;
let cityLimitsTimer = null;
let cityLimitsVersion = 0;
const cityLimitsCache = new Map();
function updateCityLimitsStatus() {
  cityLimitsStatus.textContent = !cityLimitsToggle.checked ? "Off. City boundaries work with any Map View."
    : map.getZoom() < CITY_LIMITS_MIN_ZOOM ? "Zoom in to show city limits."
    : cityLimitsGeometryStatus || (cityLimitsLoadFailed ? "City areas loaded; some city names could not load. Toggle off/on to retry."
    : "Pink shading shows city areas. Bold borders mark city limits. Zoom in for names.");
}
function cancelCityLimitsRequest() {
  clearTimeout(cityLimitsTimer);
  cityLimitsVersion++;
  cityLimitsRequest?.abort();
  cityLimitsRequest = null;
}
function displayCityLimits(data) {
  cityLimitsHalo.clearLayers();
  cityLimitsPolygons.clearLayers();
  cityLimitsHalo.addData(data);
  cityLimitsPolygons.addData(data);
  cityLimitsGeometryStatus = data.exceededTransferLimit || data.features.length >= CITY_LIMITS_MAX_FEATURES
    ? "Showing up to 80 city areas. Zoom in to see all city limits in this area."
    : !data.features.length ? "No incorporated city areas found in this view." : "";
  updateCityLimitsStatus();
}
async function loadCityLimits() {
  if (!map.hasLayer(cityLimitsLayer)) return;
  const bounds = map.getBounds().pad(0.15);
  const zoom = map.getZoom();
  const cached = [...cityLimitsCache.values()].find(item => item.zoom === zoom && item.expires > Date.now() && item.bounds.contains(map.getBounds()));
  if (cached) { displayCityLimits(cached.data); return; }
  const version = cityLimitsVersion;
  const controller = new AbortController();
  cityLimitsRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 12000);
  const params = new URLSearchParams({
    f: "geojson", where: "1=1", outFields: "GEOID,NAME", returnGeometry: "true",
    geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "4326", outSR: "4326",
    geometry: JSON.stringify({ xmin: Math.max(-180, bounds.getWest()), ymin: Math.max(-85, bounds.getSouth()), xmax: Math.min(180, bounds.getEast()), ymax: Math.min(85, bounds.getNorth()) }),
    maxAllowableOffset: String(Math.max(0.00005, 360 / (256 * 2 ** zoom))), geometryPrecision: "6",
    orderByFields: "GEOID", resultRecordCount: String(CITY_LIMITS_MAX_FEATURES)
  });
  try {
    const response = await fetch(`${CITY_LIMITS_QUERY}?${params}`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("City limits request failed");
    const data = await response.json();
    if (version !== cityLimitsVersion || !map.hasLayer(cityLimitsLayer)) return;
    if (data.error || data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.some(feature => !["Polygon", "MultiPolygon"].includes(feature.geometry?.type))) throw new Error("Invalid city limits response");
    if (data.features.length > CITY_LIMITS_MAX_FEATURES) {
      data.features = data.features.slice(0, CITY_LIMITS_MAX_FEATURES);
      data.exceededTransferLimit = true;
    }
    displayCityLimits(data);
    cityLimitsCache.set(params.toString(), { bounds, zoom, data, expires: Date.now() + 5 * 60 * 1000 });
    while (cityLimitsCache.size > 4) cityLimitsCache.delete(cityLimitsCache.keys().next().value);
  } catch (_) {
    if (version !== cityLimitsVersion || !map.hasLayer(cityLimitsLayer)) return;
    cityLimitsHalo.clearLayers();
    cityLimitsPolygons.clearLayers();
    cityLimitsGeometryStatus = "City areas could not load. Toggle off/on to retry.";
    updateCityLimitsStatus();
  } finally {
    clearTimeout(timeout);
    if (cityLimitsRequest === controller) cityLimitsRequest = null;
  }
}
function scheduleCityLimits() {
  cancelCityLimitsRequest();
  if (!map.hasLayer(cityLimitsLayer)) return;
  cityLimitsGeometryStatus = "Loading city areas…";
  updateCityLimitsStatus();
  cityLimitsTimer = setTimeout(loadCityLimits, 350);
}
function syncCityLimits() {
  const show = cityLimitsToggle.checked && map.getZoom() >= CITY_LIMITS_MIN_ZOOM;
  if (show && !map.hasLayer(cityLimitsLayer)) {
    cityLimitsLoadFailed = false;
    cityLimitsLayer.addTo(map);
    scheduleCityLimits();
  } else if (!show) {
    cancelCityLimitsRequest();
    map.removeLayer(cityLimitsLayer);
    cityLimitsHalo.clearLayers();
    cityLimitsPolygons.clearLayers();
    cityLimitsCache.clear();
  }
  updateCityLimitsStatus();
}
cityLimitsLabels.on("loading", () => { cityLimitsLoadFailed = false; updateCityLimitsStatus(); });
cityLimitsLabels.on("tileerror", () => { cityLimitsLoadFailed = true; updateCityLimitsStatus(); });
cityLimitsLabels.on("load", updateCityLimitsStatus);
cityLimitsToggle.addEventListener("change", syncCityLimits);
map.on("zoomend", syncCityLimits);
map.on("movestart", cancelCityLimitsRequest);
map.on("moveend", scheduleCityLimits);

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
  if (workAreas?.mapActive) return;
  if (e.layerType !== "polygon") return;
  activeDrawHandler = drawControl._toolbars.draw._modes.polygon.handler;
  drawActionBar.hidden = true;
});
map.on(L.Draw.Event.DRAWVERTEX, e => {
  const layers = e.layers && e.layers.getLayers();
  if (layers && layers[0] && layers[0]._icon) layers[0]._icon.classList.add("first-draw-vertex");
  if (workAreas?.mapActive) return;
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
  if (workAreas?.mapActive) return;
  if (optimoLocationPicker) { setOptimoPickPoint(event.latlng); return; }
  if (event.layer) return;
  if (mobileStopSelectionMode && window.innerWidth <= 900) {
    handleMobileStopTap(event.latlng);
  }
});

map.on("popupopen", event => {
  if (workAreas?.mapActive || optimoLocationPicker || (mobileStopSelectionMode && window.innerWidth <= 900)) {
    map.closePopup(event.popup);
    requestAnimationFrame(() => {
      if (mobileStopSelectionMode && window.innerWidth <= 900) map.closePopup();
    });
  }
});

map.on("tooltipopen", event => {
  if (event.tooltip.options.className === 'work-area-label') return;
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
  if (workAreas?.drawing) { workAreas.acceptCreated(e.layer); return; }
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
  rememberDeliveryView();
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
  if (resequenceBusy || deliverySaveInProgress || optimoLocationPicker || workAreas?.mapActive) return;
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
  refreshStreetLabels();
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
  refreshStreetLabels();
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
  const identity = rows.map(row => Object.keys(row).filter(key => !["del_status", "del_qty", "delivery_notes"].includes(key)).sort().map(key => [key, row[key]]));
  const bytes = new TextEncoder().encode(JSON.stringify([profileState.user?.id || "", window._currentFilePath || "", identity]));
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
function deliveryStopCard(row, marker = null) {
  const card = document.createElement('div'); card.className = 'delivery-stop-card';
  const line = (tag, text, className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; card.append(node); return node;
  };
  line('strong', [row['CSADR#'], row.CSSDIR, row.CSSTRT, row.CSSFUX].filter(value => value != null && String(value).trim()).join(' ') || 'Address not available', 'delivery-stop-address');
  line('div', `Bin #: ${String(row.BINNO ?? '').trim() || 'Not provided'}`, 'delivery-stop-bin');
  const total = cartTotal(row), delivered = deliveredCartCount(row);
  const remaining = total === null ? null : Math.max(0, total - delivered);
  line('strong', remaining === null ? 'Cart quantity needs checking' : remaining ? `${remaining} ${remaining === 1 ? 'cart' : 'carts'} remaining` : 'All carts delivered', 'delivery-stop-remaining');
  if (total !== null) line('div', `${delivered} of ${total} carts delivered`);
  if (marker && profileState.workspace?.mode === 'copy') {
    const button = line('button', remaining === 0 ? 'Delivery complete' : 'Record delivery', 'stop-delivery-action');
    button.type = 'button';
    button.dataset.unavailable = String(remaining === 0 || remaining === null);
    button.disabled = !profileState.user || profileState.busy || deliverySaveInProgress || resequenceBusy || remaining === 0 || remaining === null;
    button.onclick = () => recordSingleStop(marker);
  } else if (profileState.workspace?.mode === 'original') line('small', 'Team Excel · View only');
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Route & container details'; details.append(summary);
  const info = document.createElement('div');
  info.textContent = `Route ${rowRoute(row) ?? '—'} · ${dayName(Number(rowDay(row))) || 'Day not provided'} · Size ${row.SIZE ?? '—'}${rowSequence(row) !== null ? ` · Stop ${rowSequence(row)}` : ''}`;
  details.append(info); card.append(details);
  return card;
}

function processExcelBuffer(buffer, parsedWorkbook = null, confirmedRows = null) {
  const wb = parsedWorkbook || XLSX.read(new Uint8Array(buffer), { type: "array", cellStyles: true, bookVBA: true });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const rows = confirmedRows || XLSX.utils.sheet_to_json(ws);
  resetAddressSearch();
  rebuildSequenceData(rows);

  // store globally for saving later
  window._currentRows = rows;
  window._currentWorkbook = wb;
  syncSavedFilesGuide();
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

    if (!CartDeliveryFields.validCoordinates(row.LATITUDE, row.LONGITUDE) || !route || !day) return;

    let key;

const status = isDeliveredRow(row) ? "delivered" : "";

if (status === "delivered") {
  key = `${route}|Delivered`;
} else {
  key = `${route}|${day}`;
}


    const symbol = getSymbol(key);

    if (!routeDayGroups[key]) routeDayGroups[key] = { layers: [] };

const marker = createMarker(lat, lon, symbol)
  .bindPopup(() => deliveryStopCard(row, marker), { maxWidth: 300, minWidth: 220 })
  .addTo(map);
// ===== STREET LABEL (ZOOM-BASED) =====
const streetNumber = row["CSADR#"] ? String(row["CSADR#"]).trim() : "";
const streetName = row["CSSTRT"] ? String(row["CSSTRT"]).trim() : "";

const labelText = `${streetNumber} ${streetName}`.trim();

marker._streetLabelText = labelText;
marker.on('add remove', () => refreshStreetLabels());


    // 🔥 CRITICAL: link marker to Excel row
    marker._rowRef = row;
    attachQuantityBadge(marker, row);
    marker.on("click", event => {
      if (workAreas?.mapActive) return;
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

  if (globalBounds.isValid()) map.fitBounds(globalBounds, { animate: false });
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
    if (profileState.user && cartDeliveryFileNames.size) await saveCartDeliveryFileNames();
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
  return listProfileFiles();
}

// ================= UPLOAD FILE =================
function resetTeamMapping() {
  teamUploadState.inspectToken++;
  teamUploadState.cancelInspect?.();
  teamUploadState.cancelInspect = null;
  teamUploadState.worker?.terminate(); teamUploadState.worker = null;
  clearTimeout(teamUploadState.validationTimeout);
  teamUploadState.quality = null; teamUploadState.checking = false;
  teamUploadState.validationId = (teamUploadState.validationId || 0) + 1;
  profileElement('teamDataAccepted').checked = false;
  teamUploadState.inspection = null; teamUploadState.mapping = null; teamUploadState.inspecting = false;
  profileElement('teamMappingConfirmed').checked = false;
  profileElement('teamMappingFields').replaceChildren();
}
function renderTeamMapping() {
  const { inspection, mapping } = teamUploadState;
  const container = profileElement('teamMappingFields'); container.replaceChildren();
  if (!inspection) return;
  profileElement('teamMappingSummary').textContent = `${inspection.sheetName} · ${inspection.rowCount.toLocaleString()} stops · ${inspection.headers.length} columns`;
  const primary = document.createElement('div'); primary.className = 'team-mapping-grid';
  const extra = document.createElement('details'); extra.className = 'profile-explainer';
  const summary = document.createElement('summary'); summary.textContent = 'Address, bins and existing deliveries';
  const optional = document.createElement('div'); optional.className = 'team-mapping-grid';
  extra.append(summary, optional); container.append(primary, extra);
  CartDeliveryFields.fields.forEach((field, index) => {
    const card = document.createElement('div'); card.className = 'team-mapping-field';
    const label = document.createElement('label'); label.htmlFor = `team-map-${field.key}`;
    label.textContent = `${field.label}${field.required ? ' *' : ''}`;
    const select = document.createElement('select'); select.id = label.htmlFor; select.dataset.mappingField = field.key;
    select.add(new Option(field.required ? 'Choose a column…' : 'Not used', ''));
    inspection.headers.forEach(header => select.add(new Option(header, header)));
    select.value = mapping[field.key] || '';
    const hint = document.createElement('small'); hint.textContent = inspection.hints[field.key];
    const sample = document.createElement('p'); sample.className = 'team-mapping-sample'; sample.id = `team-sample-${field.key}`;
    select.setAttribute('aria-describedby', sample.id);
    const updateSample = () => {
      const values = (inspection.samples[select.value] || []).map(value => String(value)).filter(value => value.trim()).slice(0, 3);
      sample.textContent = select.value ? values.length ? `Sample: ${values.map(value => value.length > 80 ? value.slice(0, 77) + '…' : value).join(' · ')}` : 'The first five stops have no values in this column.' : 'This field will not be imported.';
    };
    select.onchange = () => {
      if (select.value) mapping[field.key] = select.value; else delete mapping[field.key];
      hint.textContent = 'Your selection';
      profileElement('teamMappingConfirmed').checked = false;
      updateSample(); validateTeamData();
    };
    updateSample(); card.append(label, select, hint, sample);
    (index < 5 ? primary : optional).append(card);
  });
}
async function inspectTeamUpload(file) {
  resetTeamMapping();
  const token = teamUploadState.inspectToken;
  teamUploadState.inspecting = true;
  profileElement('teamUploadStatus').textContent = 'Reading column names and sample values on this device…';
  renderTeamUpload();
  let worker;
  try {
    const bytes = await file.arrayBuffer();
    if (token !== teamUploadState.inspectToken) return;
    worker = new Worker('profile-import-worker.js?v=20261012-delivery-ease');
    const inspection = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('IMPORT_DEVICE_LIMIT')), 120000);
      teamUploadState.cancelInspect = () => { clearTimeout(timeout); worker.terminate(); resolve(null); };
      worker.onmessage = ({ data }) => { clearTimeout(timeout); data.error ? reject(new Error(data.error)) : resolve(data); };
      worker.onerror = () => { clearTimeout(timeout); reject(new Error('IMPORT_DEVICE_LIMIT')); };
      worker.postMessage({ bytes }, [bytes]);
    });
    if (token !== teamUploadState.inspectToken || !inspection) return;
    const { mapping, hints } = CartDeliveryFields.suggest(inspection.headers);
    teamUploadState.inspection = { ...inspection, hints };
    teamUploadState.mapping = mapping;
    teamUploadState.worker = worker;
    worker.onmessage = ({ data }) => {
      if (token !== teamUploadState.inspectToken || data.validationId !== teamUploadState.validationId) return;
      clearTimeout(teamUploadState.validationTimeout);
      teamUploadState.quality = data.quality;
      if (data.error) profileElement('teamUploadStatus').textContent = 'The data check could not finish. Choose this file again to retry.';
      teamUploadState.checking = false; renderTeamUpload();
    };
    worker.onerror = () => {
      if (token !== teamUploadState.inspectToken) return;
      clearTimeout(teamUploadState.validationTimeout);
      teamUploadState.quality = null; teamUploadState.checking = false;
      profileElement('teamUploadStatus').textContent = 'The data check could not finish. Choose this file again to retry.';
      renderTeamUpload();
    };
    renderTeamMapping();
    profileElement('teamUploadStatus').textContent = '';
    validateTeamData();
  } catch (error) {
    if (token === teamUploadState.inspectToken) {
      profileElement('teamUploadStatus').textContent = profileMessage(error);
      profileElement('teamUploadStatus').dataset.state = 'error';
    }
  } finally {
    if (teamUploadState.worker !== worker) worker?.terminate();
    if (token === teamUploadState.inspectToken) {
      teamUploadState.inspecting = false; teamUploadState.cancelInspect = null; renderTeamUpload();
    }
  }
}
function validateTeamData() {
  teamUploadState.quality = null;
  teamUploadState.validationId = (teamUploadState.validationId || 0) + 1;
  teamUploadState.checking = false;
  clearTimeout(teamUploadState.validationTimeout);
  profileElement('teamDataAccepted').checked = false;
  if (teamUploadState.worker && !CartDeliveryFields.errors(teamUploadState.mapping, teamUploadState.inspection.headers).length) {
    teamUploadState.checking = true;
    const validationId = teamUploadState.validationId;
    teamUploadState.validationTimeout = setTimeout(() => {
      if (validationId !== teamUploadState.validationId) return;
      teamUploadState.validationId++; teamUploadState.checking = false;
      profileElement('teamUploadStatus').textContent = 'The data check could not finish. Choose this file again to retry.';
      renderTeamUpload();
    }, 120000);
    teamUploadState.worker.postMessage({ validate: teamUploadState.mapping, validationId });
  }
  renderTeamUpload();
}
function teamDataReady() {
  const quality = teamUploadState.quality;
  return quality && !teamUploadState.checking && quality.mappable > 0 && (!quality.affected || profileElement('teamDataAccepted').checked);
}
function renderTeamDataCheck() {
  const { quality, checking } = teamUploadState;
  const container = profileElement('teamDataCheck'); container.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = 'Upload data check'; container.append(heading);
  const summary = document.createElement('p');
  summary.textContent = checking ? 'Checking every row with your column matches…' : !quality ? 'Choose valid column matches to check your data.'
    : quality.affected ? `${quality.affected.toLocaleString()} of ${quality.total.toLocaleString()} rows need attention.` : `All ${quality.total.toLocaleString()} rows passed the data check.`;
  container.append(summary);
  quality?.issues.forEach(issue => {
    const item = document.createElement('p');
    const label = document.createElement('strong'); label.textContent = `${issue.count.toLocaleString()} · ${issue.label}`;
    const explanation = document.createElement('span'); explanation.textContent = `${issue.effect} Spreadsheet rows: ${issue.examples.join(', ')}${issue.count > issue.examples.length ? '…' : '.'}`;
    item.append(label, document.createElement('br'), explanation); container.append(item);
  });
  if (quality?.mappable === 0) {
    const blocked = document.createElement('p'); blocked.textContent = 'No stops have usable coordinates. Fix the spreadsheet or change the column matches before uploading.'; container.append(blocked);
  }
  profileElement('teamDataAcceptLabel').hidden = !quality?.affected || quality.mappable === 0;
  profileElement('teamDataAccepted').disabled = profileState.busy || Boolean(teamUploadState.result);
}
function renderTeamUpload() {
  const { file, result, added } = teamUploadState;
  const busy = profileState.busy;
  profileElement('teamUploadTitle').textContent = added ? 'Your team Excel is ready' : 'Upload new team Excel';
  profileElement('teamUploadSetup').hidden = added;
  profileElement('teamUploadSelection').hidden = !file;
  profileElement('teamUploadFileName').textContent = file?.name || '';
  profileElement('teamUploadFileSize').textContent = file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Destination: Cart Delivery` : '';
  profileElement('chooseTeamExcelBtn').textContent = file ? 'Choose a different file' : 'Choose Excel file';
  profileElement('teamUploadDialog').setAttribute('aria-busy', String(busy));
  profileElement('teamUploadDialog').querySelectorAll('button').forEach(button => { button.disabled = busy; });
  profileElement('chooseTeamExcelBtn').disabled = busy || Boolean(result);
  const inspection = teamUploadState.inspection;
  const errors = inspection ? CartDeliveryFields.errors(teamUploadState.mapping, inspection.headers) : [];
  renderTeamDataCheck();
  profileElement('teamUploadMapping').hidden = !inspection || added;
  profileElement('teamMappingErrors').textContent = errors.join(' ');
  profileElement('teamMappingConfirmed').disabled = busy || Boolean(result) || errors.length > 0;
  profileElement('teamMappingFields').querySelectorAll('select').forEach(select => { select.disabled = busy || Boolean(result); });
  const confirm = profileElement('confirmTeamUploadBtn');
  confirm.hidden = added;
  confirm.disabled = busy || !file || (!result && (!inspection || teamUploadState.inspecting || errors.length > 0 || !teamDataReady() || !profileElement('teamMappingConfirmed').checked));
  confirm.textContent = busy ? 'Adding your team Excel…' : teamUploadState.inspecting ? 'Reading columns…' : !profileState.user ? 'Sign in to upload this file' : result ? 'Retry adding to Cart Delivery' : 'Upload & add to Cart Delivery';
  profileElement('viewUploadedFileBtn').hidden = !added;
  profileElement('openUploadedCopyBtn').hidden = !added;
}
function teamUploadFileError(file) {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return 'Choose an Excel (.xlsx or .xls) or CSV file.';
  if (file.name.length > 180 || /[\/\\\x00-\x1f]/.test(file.name)) return 'Shorten the filename to 180 characters or fewer and remove slashes, then choose it again.';
  if (!file.size) return 'This file is empty. Choose an Excel file with delivery stops.';
  if (file.size > 50000000) return 'This file is over 50 MB. Choose a smaller file.';
  return '';
}
function openTeamUpload(file = null) {
  if (profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  if (file || teamUploadState.added) {
    resetTeamMapping();
    teamUploadState.file = file; teamUploadState.result = null; teamUploadState.added = false;
    const error = file ? teamUploadFileError(file) : '';
    if (error) teamUploadState.file = null;
    profileElement('teamUploadStatus').textContent = error;
    profileElement('teamUploadStatus').dataset.state = error ? 'error' : '';
  }
  profileElement('fileManagerModal').style.display = 'none';
  profileElement('profileDialog').close();
  closeMobileMenu();
  renderTeamUpload();
  if (!profileElement('teamUploadDialog').open) profileElement('teamUploadDialog').showModal();
  if (file && teamUploadState.file) inspectTeamUpload(file);
}
async function uploadFile(file = teamUploadState.file) {
  if (!file || profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  if (file !== teamUploadState.file) openTeamUpload(file);
  if (teamUploadFileError(file)) return;
  if (!teamUploadState.result && (!teamUploadState.inspection || teamUploadState.inspecting ||
    CartDeliveryFields.errors(teamUploadState.mapping, teamUploadState.inspection.headers).length || !teamDataReady() || !profileElement('teamMappingConfirmed').checked)) return;
  if (!profileState.user) {
    teamUploadState.resume = true;
    profileElement('teamUploadDialog').close();
    requireProfile();
    profileElement('profileStatus').textContent = 'Sign in to add this team Excel. Your selected file will be waiting here.';
    return;
  }
  const generation = profileState.generation;
  profileState.busy = true; renderProfileState();
  const status = profileElement('teamUploadStatus');
  status.dataset.state = '';
  const progress = message => { if (generation === profileState.generation) status.textContent = message; };
  progress('Uploading your team Excel. Keep this screen open…');
  try {
    const result = teamUploadState.result || await importProfileFile({ name: file.name }, file, progress, { ...teamUploadState.mapping });
    if (generation !== profileState.generation) return;
    teamUploadState.result = result;
    progress('Adding your file to the Cart Delivery tab…');
    await loadSharedCartDeliveryNames();
    if (generation !== profileState.generation) return;
    const before = new Set(cartDeliveryFileNames);
    const key = result.sourceKey || result.name;
    if (!cartDeliveryFileNames.has(key)) {
      cartDeliveryFileNames.add(key);
      try { await saveCartDeliveryFileNames(); }
      catch (error) { cartDeliveryFileNames = before; throw error; }
    }
    if (generation !== profileState.generation) return;
    teamUploadState.added = true;
    teamUploadState.worker?.terminate(); teamUploadState.worker = null;
    status.dataset.state = 'saved';
    status.textContent = `${result.name} · ${result.rowCount.toLocaleString()} stops. Added to Open / Switch File → Cart Delivery for everyone. Open your own copy when you’re ready to record deliveries.`;
  } catch (error) {
    if (generation === profileState.generation) {
      status.dataset.state = 'error';
      status.textContent = teamUploadState.result
        ? 'Your team Excel is saved, but we could not confirm it was added to Cart Delivery. Retry below to finish adding it. You do not need to upload it again.'
        : error.message?.includes('NAME_EXISTS') ? 'A team Excel with this name already exists. Close this window to open it from Saved Files, or rename your new file and choose it again.' : profileMessage(error);
    }
  } finally { profileState.busy = false; renderProfileState(); }
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
  const profileButton = document.getElementById('profileWorkspaceBtn');

  if (window.innerWidth <= 900) {
    document.querySelector('.header-top').append(profileButton);
    quickActions.insertBefore(locateBtn, moreBtn);
    quickActions.insertBefore(copyLocationBtn, moreBtn);
    moreActions.append(clearBtn, undoBtn, streetLabel, refreshBtn);
    moreActions.prepend(recordCartsBtn, loadLogBtn);
    dock.insertBefore(saveStatus, quickActions);
  } else {
    document.querySelector('.header-workspace').append(profileButton);
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

// Shared boundaries have their own layers and revision, independent of delivery selection.
function setupWorkAreas() {
  const el = id => document.getElementById(id);
  const dialog = el('workAreasDialog'), visible = el('workAreasVisible');
  const pane = map.createPane('workAreasPane'); pane.style.zIndex = '310'; pane.style.pointerEvents = 'none';
  const labelPane = map.createPane('workAreaLabelsPane'); labelPane.style.zIndex = '360'; labelPane.style.pointerEvents = 'none';
  const layer = L.layerGroup(), draftLayer = L.featureGroup().addTo(map);
  let state = {}, contextKey = '', returnCopyFileId = null;
  const node = (tag, text, className) => {
    const n = document.createElement(tag); n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const canEdit = () => Boolean(profileState.user && profileState.workspace?.fileId &&
    profileState.workspace.mode === 'original' && !profileState.busy && state.loaded);
  const message = text => { el('workAreaSaveStatus').textContent = text; };
  const profileLabel = profile => `${profile.name}${profile.id === profileState.user?.id ? ' (you)' : ''}`;
  const shownAreas = () => (state.snapshot?.areas || []).filter(area => !state.filter || state.filter === 'all' || area.profileId === (state.filter === 'mine' ? profileState.user?.id : state.filter));
  function renderFilters() {
    const areas = state.snapshot?.areas || [], profiles = state.snapshot?.profiles || [];
    if (state.filter && !['all','mine'].includes(state.filter) && !profiles.some(profile => profile.id === state.filter)) state.filter = 'all';
    const choices = [['all', `All profiles (${areas.length})`], ['mine', `My areas (${areas.filter(area => area.profileId === profileState.user?.id).length})`],
      ...profiles.filter(profile => profile.id !== profileState.user?.id).map(profile => [profile.id, `${profile.name} (${areas.filter(area => area.profileId === profile.id).length})`])];
    for (const id of ['workAreasFilter','workAreasListFilter']) {
      const select = el(id), key = JSON.stringify(choices);
      if (select.dataset.choices !== key) { select.replaceChildren(...choices.map(([value,label]) => new Option(label,value))); select.dataset.choices = key; }
      select.value = state.filter || 'all'; select.disabled = !state.loaded || state.busy;
    }
  }
  function assignmentPreview() {
    if (!state.draft) return;
    const profile = state.snapshot.profiles.find(item => item.id === el('workAreaProfile').value);
    el('workAreaAssignmentPreview').textContent = `${el('workAreaName').value.trim() || 'New area'} → ${profile ? profileLabel(profile) : 'Choose a profile'}. ${state.draft.geometry ? 'Save to share this assignment with everyone.' : 'Draw a boundary before saving.'}`;
  }
  const errorText = error => {
    if (/CLIENT_UPDATE_REQUIRED|cd_work_areas|SETUP_REQUIRED/.test(error.message)) return 'Work areas need the server update before they can be used.';
    if (/STALE_VERSION/.test(error.message)) return 'Another profile changed these areas. Your edit was not saved. Cancel this edit, refresh, and reopen the area to use the latest boundaries.';
    if (/INVALID_WORK_AREA_PROFILE/.test(error.message)) return 'That profile is no longer available. Cancel and refresh to choose a current profile.';
    if (/INVALID_WORK_AREA/.test(error.message)) return 'Check the profile, name and boundary. Use a closed area with 3–500 corners; keep the total under 100 areas and 10,000 points.';
    return 'Could not confirm the shared save. Retry uses the same request. Close and refresh to check what reached the server.';
  };
  function renderMap() {
    layer.clearLayers();
    for (const area of shownAreas()) {
      const title = node('span', `${area.profileName} · ${area.name}`);
      L.geoJSON(area.geometry, { pane: 'workAreasPane', interactive: false,
        style: { color: area.color, fillColor: area.color, fillOpacity: 0.12, opacity: 0.95, weight: 3 }
      }).eachLayer(polygon => {
        polygon.bindTooltip(title, { permanent: true, direction: 'center', className: 'work-area-label',
          pane: 'workAreaLabelsPane', interactive: false });
      }).addTo(layer);
    }
    if (visible.checked && profileState.user && state.loaded) layer.addTo(map);
    else if (map.hasLayer(layer)) map.removeLayer(layer);
  }
  function render() {
    const workspace = profileState.workspace, signed = Boolean(profileState.user), editable = canEdit();
    renderFilters();
    const shown = shownAreas(), total = state.snapshot?.areas.length || 0;
    const overlayStatus = !visible.checked ? 'Work areas are hidden.' : state.filter === 'mine' && !shown.length ? 'No areas assigned to you yet.'
      : `${shown.length} of ${total} ${total === 1 ? 'area' : 'areas'} shown.`;
    visible.disabled = !signed || !workspace?.fileId;
    el('manageWorkAreasBtn').disabled = !state.loaded || state.busy || profileState.busy || !signed;
    el('manageWorkAreasBtn').textContent = editable ? 'Manage work areas' : 'View work areas';
    el('prepareWorkAreasBtn').hidden = !(signed && workspace?.legacy && workspace.mode === 'original');
    el('prepareWorkAreasBtn').disabled = profileState.busy;
    el('refreshWorkAreasBtn').disabled = !signed || !workspace?.fileId || state.loading || state.busy;
    el('workAreasStatus').textContent = !signed ? 'Sign in to see profile work areas.' : !workspace ? 'Open a team file or your copy to see work areas.'
      : !workspace.fileId ? state.error || 'Enable work areas on the team Excel to share boundaries for this file.'
      : state.error || (state.loading && !state.loaded ? 'Loading shared work areas…'
      : `${overlayStatus} ${workspace.mode === 'original' ? 'Edit here for everyone.' : 'View only in your copy; edit on the team Excel.'}`);
    el('workAreasTitle').textContent = state.draft ? state.draft.existing ? 'Edit work area' : 'Add work area' : 'Profile work areas';
    el('workAreasHelp').textContent = `${workspace?.name || ''} · ${workspace?.mode === 'original' ? 'Team Excel — you can edit areas and assign profiles here.' : 'Your copy — view areas here. To change boundaries or assignments, open the team Excel.'}`;
    el('workAreasTeamBtn').hidden = !signed || workspace?.mode !== 'copy';
    el('workAreasTeamBtn').disabled = state.busy || profileState.busy;
    el('workAreasReturnBtn').hidden = !signed || workspace?.mode !== 'original' || workspace.fileId !== returnCopyFileId;
    el('workAreasReturnBtn').disabled = state.busy || profileState.busy;
    const legend = el('workAreasLegend'); legend.replaceChildren();
    const profiles = new Map();
    for (const area of shownAreas()) {
      const key = `${area.profileId}:${area.color}`;
      const entry = profiles.get(key) || { ...area, count: 0 }; entry.count++; profiles.set(key, entry);
    }
    for (const profile of profiles.values()) {
      const item = node('div', '', 'work-area-legend-item');
      const swatch = node('i', '', 'work-area-swatch'); swatch.style.backgroundColor = profile.color;
      item.append(swatch, node('span', `${profile.profileName}${profile.profileId === profileState.user?.id ? ' (you)' : ''} · ${profile.count}`)); legend.append(item);
    }
    el('workAreasBrowse').hidden = Boolean(state.draft);
    el('workAreaForm').hidden = !state.draft;
    el('newWorkAreaBtn').hidden = !editable;
    el('newWorkAreaBtn').disabled = state.busy || Boolean(state.pending) || (state.snapshot?.areas.length || 0) >= 100;
    el('workAreaFields').disabled = !editable || state.busy || Boolean(state.pending);
    el('saveWorkAreaBtn').disabled = !editable || state.busy || state.conflict || !state.draft?.geometry;
    el('saveWorkAreaBtn').textContent = state.busy ? 'Saving…' : state.pending ? 'Retry save for everyone' : 'Save for everyone';
    el('cancelWorkAreaBtn').disabled = state.busy;
    el('closeWorkAreasBtn').disabled = state.busy;
    el('deleteWorkAreaBtn').hidden = !state.draft?.existing;
    el('deleteWorkAreaBtn').disabled = !editable || state.busy || Boolean(state.pending);
    el('retryWorkAreaSaveBtn').hidden = !state.pending || Boolean(state.draft) || state.conflict;
    el('retryWorkAreaSaveBtn').disabled = state.busy || !editable;
    el('workAreaBoundaryStatus').textContent = state.draft?.geometry ? 'Boundary ready. Keep it as it is, move its corners, or draw a replacement.' : 'Tap Draw boundary, then tap at least 3 corners around the delivery area.';
    el('drawWorkAreaBtn').textContent = state.draft?.geometry ? 'Draw again' : 'Draw boundary';
    el('adjustWorkAreaBtn').hidden = !state.draft?.geometry;
    syncAssignedProfileColor();
    assignmentPreview();
    const list = el('workAreasList'); list.replaceChildren();
    if (!shownAreas().length) {
      const empty = node('div', '', 'work-area-empty');
      empty.append(node('strong', state.filter === 'mine' ? 'No areas assigned to you yet' : state.snapshot?.areas.length ? 'No areas for this profile yet' : 'Plan who delivers where'),
        node('p', editable ? 'Add a work area, choose who will deliver there, and draw its boundary.' : 'Open the team Excel to add areas or assign them to a profile.'));
      list.append(empty);
    }
    for (const area of shownAreas()) {
      const card = node('article', '', 'work-area-card'); card.style.borderLeftColor = area.color;
      card.append(node('strong', area.name), node('p', `Assigned to ${area.profileName}${area.profileId === profileState.user?.id ? ' (you)' : ''}`, 'work-area-assignee'));
      const actions = node('div', '', 'work-area-card-actions');
      const zoom = node('button', 'Show on map'); zoom.type = 'button';
      zoom.disabled = state.busy || Boolean(state.pending);
      zoom.onclick = () => {
        visible.checked = true; renderMap(); dialog.close(); closeMobileMenu();
        map.fitBounds(L.geoJSON(area.geometry).getBounds(), { padding: [30,30], maxZoom: 17 });
      };
      actions.append(zoom);
      if (editable) {
        const edit = node('button', 'Edit area'), assign = node('button', 'Assign profile');
        edit.type = assign.type = 'button'; edit.disabled = assign.disabled = state.busy || Boolean(state.pending);
        edit.onclick = () => editArea(area);
        assign.onclick = () => { editArea(area); el('workAreaProfile').focus(); };
        actions.append(edit, assign);
      }
      card.append(actions);
      list.append(card);
    }
  }
  async function refresh() {
    if (!profileState.user || !profileState.workspace?.fileId || state.loading || state.busy) return;
    const session = state, fileId = profileState.workspace.fileId;
    session.loading = true; render();
    try {
      const result = await profileApi({ action: 'work-areas', fileId });
      if (session !== state || state.busy) return;
      if (!result || result.fileId !== fileId || !Array.isArray(result.areas) || !Array.isArray(result.profiles)) throw new Error('SETUP_REQUIRED');
      if (!state.snapshot || result.revision >= state.snapshot.revision) state.snapshot = result;
      state.loaded = true; state.error = ''; renderMap();
    } catch (error) {
      if (session === state) state.error = /CLIENT_UPDATE_REQUIRED|SETUP_REQUIRED/.test(error.message) ? errorText(error)
        : `Could not refresh work areas.${state.loaded ? ' Showing the last confirmed boundaries.' : ' Tap Refresh areas to retry.'}`;
    } finally { if (session === state) { state.loading = false; render(); } }
  }
  function syncContext() {
    const workspace = profileState.workspace;
    if (!profileState.user || workspace?.fileId !== returnCopyFileId) returnCopyFileId = null;
    const key = `${profileState.user?.id || ''}:${workspace?.fileId || workspace?.sourceKey || ''}:${workspace?.mode || ''}`;
    if (key === contextKey) { render(); return; }
    stopBoundary(false, false); dialog.close(); contextKey = key;
    state = { loaded: false, loading: false, busy: false, snapshot: null, draft: null, pending: null, error: '', conflict: false, mapMode: null };
    layer.clearLayers(); if (map.hasLayer(layer)) map.removeLayer(layer);
    message(''); render(); refresh();
  }
  function syncAssignedProfileColor() {
    const profile = state.snapshot?.profiles.find(item => item.id === el('workAreaProfile').value);
    const color = /^#[0-9a-f]{6}$/i.test(profile?.color || '') ? profile.color : null;
    el('workAreaProfileColor').hidden = !color;
    el('workAreaAppearance').hidden = Boolean(color);
    el('workAreaColor').disabled = Boolean(color);
    if (!color) return;
    const picker = el('workAreaColor');
    if (![...picker.options].some(option => option.value === color)) picker.add(new Option('Profile color',color));
    picker.value = color;
    el('workAreaProfileColor').querySelector('i').style.backgroundColor = color;
    el('workAreaProfileColor').querySelector('span').textContent = `Uses ${profile.name}’s profile color. An admin can change it in profile administration.`;
  }
  function editArea(area = null) {
    if (!canEdit() || state.busy || state.pending) return;
    const own = state.snapshot.areas.find(item => item.profileId === profileState.user.id);
    state.draft = { id: area?.id || crypto.randomUUID(), existing: Boolean(area), geometry: area ? structuredClone(area.geometry) : null,
      revision: state.snapshot.revision, areas: structuredClone(state.snapshot.areas) };
    state.conflict = false;
    el('workAreaName').value = area?.name || '';
    el('workAreaProfile').replaceChildren(...state.snapshot.profiles.map(profile => new Option(profileLabel(profile), profile.id)));
    el('workAreaProfile').value = area?.profileId || profileState.user.id;
    el('workAreaColor').value = area?.color || own?.color || '#2563eb';
    if (!el('workAreaColor').value) el('workAreaColor').value = '#2563eb';
    if (!area && !own) el('workAreaProfile').onchange();
    el('workAreaAppearance').open = false;
    message(''); render(); dialog.scrollTop = 0; el('workAreaName').focus();
  }
  function startBoundary(adjust = false) {
    if (!canEdit() || !state.draft || state.busy || state.pending || optimoLocationPicker || resequenceBusy || deliverySaveInProgress) return;
    if (Object.values(drawControl._toolbars).some(toolbar => toolbar.enabled())) {
      message('Finish or cancel your stop-selection shape before editing a work area.'); return;
    }
    state.mapMode = adjust ? 'adjust' : 'draw';
    dialog.close(); closeMobileMenu(); map.closePopup(); el('mobileStopPicker').hidden = true;
    document.body.classList.add('editing-work-area');
    el('workAreaMapEditor').hidden = false;
    el('workAreaMapTitle').textContent = `${adjust ? 'Adjust' : 'Draw'} boundary · ${el('workAreaName').value.trim() || 'New area'}`;
    el('workAreaMapHelp').textContent = adjust ? 'Drag a circle to move a corner. Drag a faded circle to add a corner. Tap Use boundary when finished, then save.' : 'Tap at least 3 corners around the area. Pinch to zoom or drag to move the map. Then tap Finish boundary.';
    el('undoWorkAreaCorner').hidden = adjust;
    el('undoWorkAreaCorner').disabled = true;
    el('finishWorkAreaBoundary').disabled = !adjust;
    el('finishWorkAreaBoundary').textContent = adjust ? 'Use boundary' : 'Finish boundary';
    if (adjust) {
      state.shape = L.geoJSON(state.draft.geometry, { style: { color: el('workAreaColor').value, weight: 3, dashArray: '8 6', fillOpacity: 0.15 } }).getLayers()[0];
      state.shape.options.poly = { allowIntersection: false };
      state.shape.addTo(draftLayer); state.shape.editing.enable();
      map.fitBounds(state.shape.getBounds(), { paddingTopLeft: [45,45], paddingBottomRight: [45,190], maxZoom: 20 });
      map.fire('draw:editstart');
    } else {
      state.drawer = new L.Draw.Polygon(map, { allowIntersection: false, showArea: false,
        shapeOptions: { color: el('workAreaColor').value, weight: 3, dashArray: '8 6', fillOpacity: 0.15 } });
      state.drawer.enable();
    }
  }
  function stopBoundary(accept = false, reopen = true, geometry = null) {
    const mode = state.mapMode;
    if (accept && state.draft) state.draft.geometry = geometry || state.shape?.toGeoJSON().geometry || state.draft.geometry;
    state.mapMode = null;
    state.drawer?.disable(); state.drawer = null;
    state.shape?.editing?.disable(); state.shape = null; draftLayer.clearLayers();
    if (mode === 'adjust') map.fire('draw:editstop');
    el('workAreaMapEditor').hidden = true; document.body.classList.remove('editing-work-area');
    if (mode && reopen && state.draft && canEdit()) { render(); dialog.showModal(); }
  }
  async function saveSnapshot(areas, revision) {
    if (!canEdit() || state.busy || state.conflict) return;
    const session = state;
    state.pending ||= { action: 'work-areas-save', fileId: profileState.workspace.fileId, mode: 'original', revision,
      areas, requestId: crypto.randomUUID() };
    state.busy = true; message('Saving shared work areas…'); render();
    try {
      const result = await profileApi(state.pending);
      if (session !== state) return;
      state.snapshot = result; state.loaded = true; state.draft = null; state.pending = null; state.error = ''; state.filter = 'all';
      renderMap(); message('Saved for everyone. Other open maps refresh within 15 seconds.');
    } catch (error) {
      if (session !== state) return;
      state.conflict = /STALE_VERSION|INVALID_WORK_AREA/.test(error.message);
      message(errorText(error));
    } finally { if (session === state) { state.busy = false; render(); } }
  }
  function cancelEdit() {
    if (state.busy) return;
    state.draft = null; state.pending = null; state.conflict = false; message(''); render(); refresh();
  }
  function closeDialog() {
    if (state.busy) return;
    cancelEdit(); dialog.close();
  }
  el('manageWorkAreasBtn').onclick = () => { if (state.loaded && !state.busy) { render(); dialog.showModal(); refresh(); } };
  el('closeWorkAreasBtn').onclick = closeDialog;
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  el('newWorkAreaBtn').onclick = () => editArea();
  el('cancelWorkAreaBtn').onclick = cancelEdit;
  el('deleteWorkAreaBtn').onclick = () => {
    if (!canEdit() || !state.draft?.existing || state.busy || state.pending) return;
    const draft = state.draft, area = draft.areas.find(item => item.id === draft.id);
    if (!confirm(`Delete "${area.name}" for everyone using ${profileState.workspace.name}?`)) return;
    state.draft = null;
    saveSnapshot(draft.areas.filter(item => item.id !== draft.id), draft.revision);
  };
  el('workAreaName').oninput = assignmentPreview;
  el('workAreaProfile').onchange = () => {
    if (!state.draft) return;
    if (!state.draft.customColor) {
      const id = el('workAreaProfile').value;
      const existing = state.snapshot.areas.find(area => area.profileId === id);
      const options = el('workAreaColor').options;
      el('workAreaColor').value = existing?.color || options[Math.max(0,state.snapshot.profiles.findIndex(profile => profile.id === id)) % options.length].value;
    }
    syncAssignedProfileColor(); assignmentPreview();
  };
  el('workAreaColor').onchange = () => { if (state.draft) state.draft.customColor = true; };
  for (const id of ['workAreasFilter','workAreasListFilter']) el(id).onchange = event => {
    state.filter = event.target.value; render(); renderMap();
  };
  el('workAreasTeamBtn').onclick = async () => {
    const fileId = profileState.workspace?.fileId;
    if (!profileState.user || profileState.workspace?.mode !== 'copy' || profileState.busy || state.busy) return;
    returnCopyFileId = fileId;
    dialog.close();
    await openProfileFile({fileId}, 'original');
    if (profileState.workspace?.fileId !== fileId || profileState.workspace.mode !== 'original') return;
    dialog.showModal(); render(); refresh();
  };
  el('workAreasReturnBtn').onclick = async () => {
    const fileId = returnCopyFileId;
    if (!fileId || !profileState.user || profileState.workspace?.fileId !== fileId || profileState.busy || state.busy) return;
    dialog.close();
    await openProfileFile({fileId}, 'copy');
  };
  el('refreshWorkAreasBtn').onclick = refresh;
  el('retryWorkAreaSaveBtn').onclick = () => saveSnapshot();
  el('drawWorkAreaBtn').onclick = () => startBoundary();
  el('adjustWorkAreaBtn').onclick = () => startBoundary(true);
  el('finishWorkAreaBoundary').onclick = () => { if (state.mapMode === 'draw') state.drawer?.completeShape(); else stopBoundary(true); };
  el('cancelWorkAreaBoundary').onclick = () => stopBoundary();
  el('undoWorkAreaCorner').onclick = () => { if (state.mapMode === 'draw') state.drawer?.deleteLastVertex(); };
  el('workAreaForm').onsubmit = event => {
    event.preventDefault();
    if (!state.draft || !canEdit()) return;
    if (state.pending) { saveSnapshot(); return; }
    if (!el('workAreaForm').reportValidity() || !el('workAreaName').value.trim()) return;
    const draft = state.draft;
    const area = { id: draft.id, name: el('workAreaName').value.trim(), profileId: el('workAreaProfile').value,
      color: el('workAreaColor').value, geometry: draft.geometry };
    const areas = draft.areas.filter(item => item.id !== draft.id); areas.push(area);
    saveSnapshot(areas, draft.revision);
  };
  el('prepareWorkAreasBtn').onclick = async () => {
    const workspace = profileState.workspace;
    if (!profileState.user || !workspace?.legacy || workspace.mode !== 'original') return;
    await profileTask('profileStatus', async () => {
      showLoading('Preparing shared work areas…');
      try {
        const imported = await importProfileFile(workspace);
        await displayProfileWorkbook(await profileApi({ action: 'public-original', fileId: imported.fileId }), 'original');
      } finally { hideLoading(); }
    });
    if (profileElement('profileStatus').dataset.state === 'error') { state.error = profileElement('profileStatus').textContent; render(); }
  };
  visible.onchange = () => { render(); renderMap(); if (visible.checked) refresh(); };
  map.on('draw:drawvertex', event => {
    if (state.mapMode === 'draw') {
      const count = event.layers?.getLayers().length || 0;
      el('finishWorkAreaBoundary').disabled = count < 3;
      el('undoWorkAreaCorner').disabled = count < 2;
      el('workAreaMapHelp').textContent = `${count} ${count === 1 ? 'corner' : 'corners'} placed. ${count < 3 ? `Add ${3-count} more to make an area.` : 'Add more corners or tap Finish boundary.'} Drag the map or pinch to zoom.`;
    }
  });
  map.on('draw:drawstop', () => { if (state.mapMode === 'draw') stopBoundary(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.mapMode) stopBoundary(); });
  const autoRefresh = () => { if (!document.hidden && (visible.checked || dialog.open || el('workAreasSection').open)) refresh(); };
  setInterval(autoRefresh, 15000);
  window.addEventListener('focus', autoRefresh);
  window.addEventListener('online', autoRefresh);
  document.addEventListener('visibilitychange', autoRefresh);
  return { syncContext, refresh, get mapActive() { return Boolean(state.mapMode); }, get drawing() { return state.mapMode === 'draw'; },
    acceptCreated(polygon) { stopBoundary(true, true, polygon.toGeoJSON().geometry); } };
}

function initApp() { //begining of initApp=================================================================

setupProfileAdmin();
setupHelp();
setupPocketLock();
const openCartCounts = setupCartCounts();
recordSingleStop = marker => {
  if (profileState.workspace?.mode !== 'copy' || !profileState.user || profileState.busy || deliverySaveInProgress || resequenceBusy) return;
  const entry = Object.entries(routeDayGroups).find(([, group]) => group.layers.includes(marker));
  if (!entry || !map.hasLayer(marker) || !window._currentRows?.includes(marker._rowRef)) return;
  marker.closePopup();
  openCartCounts([{ key: entry[0], marker, row: marker._rowRef }], true);
};
setupLocationCopy();
setupLoadLog();
workAreas = setupWorkAreas();
setupDeliveryProfiles();

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
const dropZone = document.getElementById("uploadTeamExcelBtn");
const fileInput = document.getElementById("fileInput");

profileElement('uploadTeamExcelBtn').onclick = () => openTeamUpload();
profileElement('chooseTeamExcelBtn').onclick = () => { fileInput.value = ''; fileInput.click(); };
profileElement('confirmTeamUploadBtn').onclick = () => uploadFile();
profileElement('teamMappingConfirmed').onchange = renderTeamUpload;
profileElement('teamDataAccepted').onchange = renderTeamUpload;
const closeTeamUpload = () => { if (!profileState.busy) profileElement('teamUploadDialog').close(); };
profileElement('closeTeamUploadBtn').onclick = closeTeamUpload;
profileElement('teamUploadDialog').addEventListener('cancel', event => { event.preventDefault(); closeTeamUpload(); });
profileElement('viewUploadedFileBtn').onclick = () => { closeTeamUpload(); profileElement('openFileManagerBtn').click(); };
profileElement('openUploadedCopyBtn').onclick = () => {
  const file = teamUploadState.result;
  closeTeamUpload();
  if (file) openProfileFile(file);
};

// FILE SELECTED
fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) openTeamUpload(file);
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
  if (file) openTeamUpload(file);
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
    refreshStreetLabels();
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
    map.setView([39.5, -98.35], 4, { animate: false });

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

if (openFileManagerBtn) {
  openFileManagerBtn.addEventListener("click", () => {
    fileManagerModal.style.display = "flex";
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

    const workspace = profileState.workspace;
    modal.querySelector("p").textContent = workspace?.mode === "copy"
      ? `Download ${profileUsername(profileState.user)}’s saved copy of ${workspace.name}? This includes your saved changes, even those you haven't synced. Downloading does not sync them to team Excel.`
      : "Download the team Excel currently open? Reopen it first if you need the latest synced changes.";
    modal.style.display = "flex";
  });

  // Cancel download
  cancelBtn.addEventListener("click", () => {
    modal.style.display = "none";
  });

  // Confirm download
  confirmBtn.addEventListener("click", async () => {

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
    showLoading("Preparing your Excel download…");
    try { XLSX.writeFile(await profileExportWorkbook(), newFileName, { compression: true }); }
    catch (error) { alert(profileMessage(error)); }
    finally { hideLoading(); }
  });
}




// Separate labels have no marker hover handlers and never participate in selection.
const STREET_LABEL_MIN_ZOOM = 16;
const streetLabels = new Map();
let streetLabelFrame = 0, streetLabelDrawing = false;
refreshStreetLabels = () => {
  if (!streetLabelFrame) streetLabelFrame = requestAnimationFrame(updateStreetLabels);
};
function updateStreetLabels() {
  if (streetLabelFrame) cancelAnimationFrame(streetLabelFrame);
  streetLabelFrame = 0;
  const bounds = map.getBounds();
  const show = window.streetLabelsEnabled && map.getZoom() >= STREET_LABEL_MIN_ZOOM
    && !(mobileStopSelectionMode && window.innerWidth <= 900) && !streetLabelDrawing && !optimoLocationPicker && !workAreas?.mapActive;
  const keep = new Set();
  let count = 0;
  Object.values(routeDayGroups).forEach(group => {
    group.layers.forEach(layer => {
      if (!layer._streetLabelText) return;
      if (show && count < 150 && map.hasLayer(layer) && bounds.contains(layer.getLatLng())) {
        keep.add(layer);
        if (!streetLabels.has(layer)) {
          const content = document.createElement('span'); content.textContent = layer._streetLabelText;
          const label = L.tooltip({ permanent: true, interactive: false, direction: 'top', offset: [0, -18], className: 'street-label' })
            .setLatLng(layer.getLatLng()).setContent(content).addTo(map);
          streetLabels.set(layer,label);
        }
        count++;
      }
    });
  });
  for (const [marker,label] of streetLabels) if (!keep.has(marker)) { map.removeLayer(label); streetLabels.delete(marker); }
}
map.on('moveend zoomend resize', refreshStreetLabels);
map.on('draw:drawstart draw:editstart draw:deletestart', () => { streetLabelDrawing = true; refreshStreetLabels(); });
map.on('draw:drawstop draw:editstop draw:deletestop', () => { streetLabelDrawing = false; refreshStreetLabels(); });
window.addEventListener('resize', refreshStreetLabels);
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
    refreshStreetLabels();
  });

  streetToggle.addEventListener("change", (e) => {
    window.streetLabelsEnabled = e.target.checked;

    // Immediately refresh labels
    refreshStreetLabels();
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
// The server writes an immutable copy and confirms its revision before rows change.
async function saveWorkbookToCloud(rows, workbook, filePath, onProgress = () => {}) {
  return saveProfileWorkbook(rows, workbook, onProgress);
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
  const operationValue = () => dialog.querySelector('[name="cartCountOperation"]:checked').value;
  let lastBulkOperation = 'add';

  el("multipleCartsOnly").addEventListener("change", () => {
    applyFilters();
    map.closePopup();
    el("mobileStopPicker").hidden = true;
  });

  function preview() {
    if (!snapshot) return null;
    const operation = operationValue();
    const perRecord = operation === "each";
    const adding = operation !== "set";
    const changes = new Map();
    let error = "";
    let added = 0, removed = 0, changedStops = 0, completed = 0;
    const list = el("cartCountPreview");
    list.replaceChildren();
    snapshot.selected.forEach(({ row }, index) => {
      const entry = snapshot.entries[index];
      const amount = (perRecord ? entry.input : el("cartCountAmount")).value.trim();
      const value = Number(amount);
      const valid = amount !== "" && Number.isSafeInteger(value) && value >= (adding && !perRecord ? 1 : 0);
      if (!valid) error ||= perRecord ? "Enter a whole number for each stop. Use 0 where you did not deliver any carts this visit."
        : adding ? "Enter a whole number of at least 1." : "Enter a whole number of 0 or more.";
      const total = cartTotal(row);
      const current = deliveredCartCount(row);
      const next = adding ? current + value : value;
      if (total === null) error ||= "A selected stop has no valid number of carts needed. Remove it from your selection before saving.";
      else if (next > total) error ||= `This is more than the carts needed at ${formatStopAddress(row)} (Bin ${String(row.BINNO ?? '—')}). ${adding ? `Only ${total - current} remain.` : `The total cannot be higher than ${total}.`}`;
      if (!perRecord || value > 0) changes.set(row, { del_qty: next, del_status: next === total ? "Delivered" : "" });
      if (valid && total !== null && next <= total && next !== current) {
        changedStops++; added += Math.max(0, next - current); removed += Math.max(0, current - next);
        if (next === total) completed++;
      }
      entry.progress.textContent = total === null ? "Carts needed: not available" : valid && next <= total ? `After saving: ${next} of ${total} delivered · ${Math.max(0, total - next)} remaining` : `Saved now: ${current} of ${total} delivered · ${total - current} remaining`;
      entry.input.setAttribute("aria-invalid", String(!valid || total === null || next > total));
      if (index >= 50) return;
      const item = document.createElement("li");
      const address = document.createElement('strong'); address.textContent = `${formatStopAddress(row)} · Bin ${String(row.BINNO ?? '—')}`;
      const counts = document.createElement('span'); counts.textContent = total === null ? 'Carts needed: not available' : `Saved now: ${current} of ${total} · After saving: ${valid && next <= total ? next : '—'} of ${total}`;
      item.append(address, counts);
      list.append(item);
    });
    if (!error && !changes.size) error = "Enter at least one delivered cart to save. Use Close to cancel.";
    if (!error && !changedStops) error = 'These totals are already saved. Change a number or close this window.';
    el("cartCountSummary").textContent = `${snapshot.selected.length} selected ${snapshot.selected.length === 1 ? 'stop' : 'stops'} · Only these stops will be updated.`;
    const impact = el('cartCountImpact'); impact.replaceChildren();
    if (!error) {
      const total = document.createElement('strong');
      total.textContent = operation === 'set' ? `${added} carts added · ${removed} carts removed from saved totals` : `${added} ${added === 1 ? 'cart' : 'carts'} delivered this visit`;
      const stops = document.createElement('span'); stops.textContent = `${changedStops} ${changedStops === 1 ? 'stop' : 'stops'} will change${completed ? ` · ${completed} fully delivered after saving` : ''}.`;
      impact.append(total, stops);
    }
    impact.hidden = Boolean(error);
    el('cartCountDetailsTitle').textContent = snapshot.selected.length > 50 ? `See changes by stop (first 50 of ${snapshot.selected.length})` : 'See changes by stop';
    el('cartCountAmount').setAttribute('aria-invalid', String(!perRecord && Boolean(error)));
    el("cartCountStatus").textContent = error;
    el('saveCartCountsBtn').textContent = saving ? 'Saving…' : operation === 'set' ? 'Save corrected totals to my copy' : 'Save deliveries to my copy';
    el("saveCartCountsBtn").disabled = Boolean(error) || saving;
    return error ? null : changes;
  }

  function syncMode() {
    const operation = operationValue();
    const perRecord = operation === 'each';
    // A correction needs a deliberate total, not the previous visit's amount.
    if (!perRecord && operation !== lastBulkOperation) el('cartCountAmount').value = operation === 'set' ? '' : '1';
    if (!perRecord) lastBulkOperation = operation;
    el('cartCountAmountLabel').textContent = operation === 'set' ? 'Correct total delivered so far, at each stop' : 'Carts delivered this visit, per stop';
    el('cartCountAmount').min = operation === 'set' ? '0' : '1';
    el('cartCountModeHelp').textContent = operation === 'set'
      ? 'This replaces each saved total. Example: 2 already saved → enter 1 → total becomes 1. It can lower a count; 0 resets it.'
      : perRecord ? 'Add only what you delivered this visit. Example: 1 already saved + 2 entered = 3 delivered in total.'
      : `Example: enter 1 for each of ${snapshot.selected.length} ${snapshot.selected.length === 1 ? 'stop' : 'stops'} = ${snapshot.selected.length} ${snapshot.selected.length === 1 ? 'cart' : 'carts'} this visit. Existing deliveries are kept.`;
    dialog.dataset.operation = operation;
    el("cartCountBulkAmount").hidden = perRecord;
    el("cartCountAmount").disabled = perRecord;
    el("cartCountEntries").hidden = !perRecord;
    el("cartCountDetails").hidden = perRecord;
    snapshot.entries.forEach(entry => { entry.input.disabled = !perRecord; });
    preview();
  }

  function open(selected, perRecord = el("multipleCartsOnly").checked) {
    if (deliverySaveInProgress || resequenceBusy) return;
    if (!selected.length) return;
    snapshot = { selected, rows: window._currentRows, workbook: window._currentWorkbook, filePath: window._currentFilePath, entries: [] };
    el('cartCountContext').textContent = `Your copy · ${profileUsername(profileState.user)} · ${profileState.workspace?.name || window._currentFilePath || ''}`;
    el('cartCountDetails').open = false;
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
      const saved = document.createElement('span'); saved.textContent = cartTotal(row) === null ? 'Carts needed: not available' : `Saved now: ${deliveredCartCount(row)} of ${cartTotal(row)} delivered`;
      info.append(saved);
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
    dialog.querySelector(`[name="cartCountOperation"][value="${perRecord ? 'each' : 'add'}"]`).checked = true;
    lastBulkOperation = 'add';
    el("cartCountAmount").value = "1";
    syncMode();
    dialog.showModal();
  }
  el("recordCartsBtn").addEventListener("click", () => open(selectedDeliveryStops()));
  dialog.querySelectorAll('[name="cartCountOperation"]').forEach(input => input.addEventListener('change', syncMode));
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
    el('saveCartCountsBtn').textContent = 'Saving…';
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
      el('saveCartCountsBtn').textContent = operationValue() === 'set' ? 'Save corrected totals to my copy' : 'Save deliveries to my copy';
    }
  });
  return open;
}

// Records one cart per stop, prompts for per-record quantities, or undoes completion.
// Flow: collect selected rows -> upload a new workbook to Supabase -> only on success mutate
// row.del_status, move markers between routeDayGroups keys, refresh controls and sequence styling.
// Profile saves require the expected revision; only explicit reviewed sync changes an original.
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
  if (!profileState.user || profileState.workspace?.mode !== "copy" || profileState.busy) {
    setDeliverySaveStatus("error", "Open your own copy to record deliveries. The team Excel is view only.");
    return false;
  }
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
    setDeliverySaveStatus("error", profileMessage(error));
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
  setDeliverySaveStatus("saved", `Saved to your copy — ${count} ${stopLabel} ${action}${fileNote}. Sync to team Excel when ready.`);
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
