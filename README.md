# Cart Delivery (TDS-PAK)

A static web app for planning and recording cart (trash/recycling) deliveries on a map. Route stops come from Excel/CSV files stored in Supabase; drivers select stops on the map and mark them delivered. It is used mainly on an **iPhone 16 Pro Max**, so phone usability comes first.

## Run it
No build or install. Open `index.html` in a browser (or serve the folder statically, e.g. GitHub Pages). Needs internet for CDN libraries, map tiles and Supabase.

Check code: `node --check app.js` and `git diff --check`. AI assistants: also read [AGENTS.md](./AGENTS.md).

## Files
| File | Purpose |
|---|---|
| `index.html` | All markup: header, left sidebar (file open/upload, filters, search), `#map`, right `#selectionBox` (desktop actions), phone dock `#deliveryControls`, nearby-stop chooser `#mobileStopPicker`, saved-files modal `#fileManagerModal`, `#loadingOverlay`. Holds the `?v=` cache-busters for `app.js`/`style.css`. |
| `app.js` | All logic (one file, no modules). Its header comment maps the sections. |
| `style.css` | All styles. Base rules first, then many later override blocks; the last matching rule wins. Phone rules are in `@media (max-width: 900px)`; light theme is `body.sun-mode`. |
| `AGENTS.md` | Short rules for AI assistants. |

Libraries (CDN): Leaflet 1.9.4, Leaflet.Draw, leaflet-pip, SheetJS `xlsx` 0.18.5, fflate 0.8.2, `@supabase/supabase-js` v2.

## Data model
Route files are Excel/CSV; only the **first sheet** is read. One row = one stop.

| Column | Use |
|---|---|
| `LATITUDE`, `LONGITUDE` | Marker position (rows without them are skipped) |
| `ROUTE`, `DAY` | Route id and weekday number 1-7 (Monday=1); grouping, filters, colors. `NEWROUTE`/`NEWDAY` are ignored |
| `CSADR#`, `CSSDIR`, `CSSTRT`, `CSSFUX` | Address parts (number, direction, street, suffix) |
| `SIZE`, `QTY`, `BINNO` | Shown in popup / chooser |
| `SEQNO` | Optional finite, nonnegative number or numeric text (zero allowed); shown in popup/chooser and the sequence overlay |
| `del_status` | `"Delivered"` (case-insensitive) = done; empty = pending |

Saved files live in the Supabase storage bucket `excel-files`. Files named like "route summary" are ignored (the old Route Summary panel was removed).

## Key runtime state (`app.js`)
- `window._currentRows / _currentWorkbook / _currentFilePath`: the loaded file; used when saving.
- `routeDayGroups["ROUTE|DAY"]` and `["ROUTE|Delivered"]` = `{ layers: [markers] }`; drives filter checkboxes (`buildRouteDayLayerControls`) and visibility (`applyFilters`).
- Each marker: `marker._rowRef` (its row object), `marker._base` (`{lat, lon, symbol}`).
- Selection: `drawnLayer` (polygon/rectangle), `individuallySelectedMarkers`, `individuallyDeselectedMarkers`. **A stop is selected iff its marker is visible** and either it is in the first set or it is inside the drawn shape and not in the second. Always use `isStopSelected(marker, tester)` (`createSelectionTester()` builds the polygon test once).
- `sequenceGroups`: a `Map` keyed by `JSON.stringify([route, day])`, separate from marker groups. Each group contains `{ route, day, stops }`; each stop holds `{ row, seq, index, latlng }`, with `latlng: null` for an invalid location. Row references are shared with `_currentRows`, so confirmed delivery changes update styling without changing sequence order.
- `mobileStopSelectionMode`: phone tap-selection mode flag.
- `localStorage`: `cartdelivery.savedFiles.cartDelivery` (local cache of the Cart Delivery tab list; the real, shared list is the hidden bucket file `_cart-delivery-tab.json`, see `SHARED_TAB_FILE`), `sunMode` (`on`/`off`).

## Main flows
1. **Open file**: saved-files modal (`listFiles`) or upload (`uploadFile`) -> `processExcelBuffer(buffer)` clears old state and builds markers. The modal opens on the **Cart Delivery** tab.
2. **Select**: desktop clicks markers or draws polygons; phone uses **Select Stops** mode. `handleMobileStopTap` selects the nearest stop, or shows the chooser when the two nearest are within 12px. Finish with **Done**. With Select Stops off, a phone tap only opens the customer details popup (no selection).
3. **Mark delivered / undo**: `saveSelectedDeliveryStatus(markDelivered)` uploads the whole workbook with `del_status` changed; only after success does it update rows, move markers to the `|Delivered` group and refresh controls. Status shows preparation/upload stages, payload size and elapsed seconds in `#deliverySaveStatus`. **Data trust rule: markers/rows change only after a confirmed upload; never make this optimistic.** `serializeDeliveryWorkbook` generates Excel bytes, then repacks the ZIP entries with fflate level 6 (asynchronous compression for large entries). It falls back to SheetJS compression if fflate is unavailable, fails, or exceeds 20 seconds. No worksheet entries are removed. This reduces network traffic but still uploads the full workbook, so connection speed and file size matter. `window.lastDeliverySaveMetrics` records the latest upload's bytes, preparation/upload milliseconds and confirmation flag, without row data.
4. **Layout**: `placeDeliveryControls()` moves the same buttons between the phone dock (below the map) and the desktop sidebar at 900px. `syncMobile*Layout` publishes `--mobile-controls-height` / `--mobile-header-height` CSS variables through a `ResizeObserver`.
5. **Location**: Locate (follow GPS + heading); Copy Location (nearby addresses + coordinates for truck handoffs).
6. **Sequence arrows**: open **Menu** on phones (left sidebar on desktop), enable **Sequence arrows · SEQNO**, and choose all sequences or a route/day. Original paths include delivered stops and remain independent of marker visibility. See [Sequence overlay](#sequence-overlay) for styling and data rules.
7. **Truck / trailer loads**: open **More → Truck / Trailer Loads** on phones (right sidebar on desktop). Choose or create a shared truck count profile, such as **Burnet**. Manually record a load only after the crew finishes unloading it: truck/trailer, optional vehicle name, unloading date/time, approximate trash and recycling quantities. Each trip counts once. Profiles are independent of route files and cart delivery order. All-date or today totals exclude voided entries; today uses the viewing phone's local date. A mistaken load can be voided and replaced; its history remains visible.

### Sequence overlay

Blue lines and arrowheads connect consecutive stop coordinates in numeric `SEQNO` order within each original `ROUTE`/`DAY`. These are straight connections, not road directions. Stops on different routes or days never connect. Duplicate sequence values retain spreadsheet row order.

| Display | Meaning |
|---|---|
| Blue connection | At least one endpoint is pending |
| Gray dashed connection and gray arrows | Both endpoints are delivered |
| Green check badge | Delivered stop, including when its regular marker is hidden |

Rows with invalid `SEQNO`, a blank route, or a day outside integer 1–7 are omitted from the overlay with a notice. Rows with valid grouping/sequence but invalid coordinates stay in the ordered list and break the path; the overlay never bridges that missing location. Consecutive stops at the same coordinate have no connection. The toggle is disabled unless at least one route/day has adjacent stops with distinct valid locations. These rules apply to the overlay; `rowSequence()` can still show a valid sequence in a marker popup or nearby-stop chooser.

`rebuildSequenceData(rows)` runs on file load and Reset Map, rebuilding groups and the route/day dropdown. Loading another file resets the dropdown to all sequences and retains the enabled toggle only if a drawable sequence exists. Reset Map clears and disables it. Sequence controls are session state and are not saved to the workbook or localStorage.

`scheduleSequenceRender()` combines redraw requests into one animation frame. `renderSequenceLayer()` reads the confirmed row status and updates batched Canvas paths in `sequencePane` (z-index 350, below regular stop markers). The pane and paths are noninteractive, preserving map taps and selection. Badges and arrowheads use projected pixel offsets and redraw after pan, zoom, or resize. Arrow placement is clipped to the viewport and capped at 1,500 per view; lines remain complete, and short connections may have no arrowhead. After a confirmed save/undo, the shared row references supply the new status and only a redraw is needed.

### Shared load storage
- **Download Excel · selected profile** exports the selected profile and date filter, including all matching history beyond the first 30 displayed entries. The workbook has **Summary** totals and **Load History** sheets, with numeric cart quantities, UTC/local dates, IDs, and voided entries clearly marked and excluded from totals. It exports the currently loaded confirmed snapshot; refresh first for the latest data. The summary includes export and last-refresh timestamps. Downloads do not change cloud data.
- Profiles, loads and voids are small, immutable JSON objects in `excel-files/_cart-loads/`, hidden from Saved Files. No Excel upload or database migration is required for this log. It uses the bucket's existing list/read/insert permissions.
- Profile filenames use a SHA-256 hash of the normalized name, so creating **Burnet** on another phone opens the same profile. Each load has its own UUID; a void uses the original load's UUID in a separate file. Writes use `upsert: false`, and retries check the existing record before reporting success. Independent load additions do not overwrite one another.
- Counts change only after a confirmed write. Opening the panel, returning to the app or reconnecting refreshes the shared log; it also polls every 30 seconds while visible. Listing is paginated, and immutable entries already read in this session are reused. Failed refreshes keep the last complete snapshot and show a warning, rather than displaying partial totals.
- Only the last selected profile ID is stored in localStorage (`cartdelivery.loadProfile`); profiles and counts live in cloud storage. New phones do not need the old phone's local data. Load logging requires a connection; it is not an offline queue.
- Test with a fake bucket shared by two browser sessions: create profiles and simultaneous loads, retry a lost upload response, reject saves/reads, void entries, and switch route files. Never test writes against the real bucket.

## How-to recipes
- **New shared button**: add it in `index.html`, place it in both branches of `placeDeliveryControls()`, style both layouts.
- **Delivery control appearance**: shared buttons use `delivery-action` and `data-action` for purpose colors and decorative CSS icons. The final action styles in `style.css` cover both themes, active/disabled/saving states, and the phone/desktop placements. Keep text labels; JS updates them without removing the icons.
- **Different route/day column names**: change only `rowRoute()` / `rowDay()` in `app.js`; every other place (grouping, nearby-stop chooser, delivered save) reads route/day through them. Never read `row.ROUTE`/`row.DAY` directly.
- **Sequence column or appearance**: parse sequence values in `rowSequence()`, group/sort in `rebuildSequenceData()`, and draw in `renderSequenceLayer()`. Keep original row references and ordering independent of marker visibility. Styling lives in the sequence Canvas paths in `app.js`; sidebar controls use the final `.sequence-controls` rules in `style.css`.
- **New spreadsheet column in popups**: extend `popupContent` in `processExcelBuffer` (and `showNearbyStopPicker` if relevant).
- **Tap sensitivity**: `getNearbyVisibleStops` (hit radius) and `handleMobileStopTap` (12px ambiguity threshold).
- **New selection-based action**: iterate `routeDayGroups`, filter with `isStopSelected`, then call `updateSelectionCount()` and `updateUndoButtonState()`.
- **Saving a file**: reuse `saveWorkbookToCloud(rows, workbook, filePath)`; on failure the old workbook is untouched.
- After editing `app.js`/`style.css`, bump `?v=` in `index.html`.

## Known quirks / cautions
- `initApp()` is large; some helpers (e.g. `setMobileStopSelectionMode`) are declared inside it or inside `if` blocks. `updateSelectionCount` is re-assigned in the mobile selection section to also update the phone button.
- `DELETE_PASSWORD` in `app.js` is a client-side speed bump only. The Supabase key is a public publishable key; enforce storage permissions in Supabase.
- Saving rewrites the whole file (last writer wins if two devices edit the same file).
- Nearby-stop lookup scans all visible markers per tap; re-evaluate if routes reach many thousands of stops.
- `HEADER_TOOL_LINKS` still has placeholder `#` links.

## Usage assumptions
- One phone edits delivery status at a time; other phones only view, so there is no multi-writer conflict handling. Each save overwrites the whole file from what that phone loaded. Viewers see a file as it was when opened (reopen it or use Refresh App to see updates). If multi-driver editing is ever needed, reload the latest file before each save and apply only the changed rows.
- Phone taps: with Select Stops off a tap opens the customer popup; with it on a tap selects (see `handleMobileStopTap`). Street labels (`updateStreetLabels`) show from zoom 16 when the checkbox is on and Select Stops is off.

- Backup download (top-left ⬇ button): saves the whole open workbook, including current `del_status`, as `<Base>_Backup_YYYY-MM-DD_HHMM.xlsx`. `getDownloadBaseName` strips earlier `_Backup_`/`_Downloaded_` stamps and ` (1)` suffixes so names never grow after download -> upload cycles; the timestamp shows which copy is newest. Keep this behaviour.

- **Cart Delivery tab is shared across phones**: `listFiles` loads `_cart-delivery-tab.json` from the bucket each time; add/remove calls `saveCartDeliveryFileNames()` (async, throws) and reverts on failure. The file is hidden from lists. First load seeds it from the phone's old localStorage list. Don't rename or delete it.

- **Dynamic Island / notch**: `index.html` uses `viewport-fit=cover`; header, sidebar, map and dock offsets use `env(safe-area-inset-*)` (the JS in `placeDeliveryControls`/layout observer measures the real header height, so the sidebar and map start below it). To test, replace `env(safe-area-inset-top)` with `59px` and `env(safe-area-inset-bottom)` with `34px` in a copy of the CSS (iPhone 16 Pro Max values). Any new fixed/absolute element near a screen edge must include the matching `env()` inset.

## Testing
Build a small workbook in the browser console (`XLSX.utils.json_to_sheet`) and call `processExcelBuffer(...)` at 440x956 and desktop widths. Check: with **Select Stops** enabled, a direct phone tap selects and an overlapping tap opens the chooser; with it off, a tap opens details. Also check desktop clicks, polygon + single deselect, Done, no horizontal scroll, and no console errors. Don't save to the real bucket while testing.

For the sequence overlay, use unsorted `SEQNO` values such as `10`, `2`, and `0`, multiple routes/days, and delivered stops. Verify numeric order, separate paths, hidden delivered badges, and unchanged stop selection with the overlay on. Check duplicate values, invalid sequence/day/location values, and colocated stops; then pan/zoom, switch files, toggle the overlay, and Reset Map. With an intercepted or fake upload, verify delayed/failed saves leave rows, badges, and colors unchanged; successful delivery and undo update styling while preserving connections. Never let a test upload reach the real bucket.

- **Polygon drawing on touch**: Leaflet.Draw's `_onTouch` is overridden in `app.js` (above `drawControl`) so a vertex is added only on a quick, non-moving, single-finger tap; panning/pinching while drawing adds no points.

- **Closing polygons**: while drawing, the first point turns green/large and a **Finish Shape** / **Cancel** bar appears at the top of the map after 3 points (`EASIER SHAPE CLOSING` in `app.js`, `#drawActionBar` in `style.css`).


## Install as a home-screen app (PWA)

On iPhone: open the site in Safari, tap Share, then **Add to Home Screen**. It opens full-screen with its own icon.

- Files: `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`. The service worker is registered at the end of `app.js`.
- App files use network-first (updates arrive immediately, cached copy only when offline). Map tiles are cached (up to 600) for faster/offline panning.
- Supabase requests are **never** cached, so delivery data is always live. Saving still requires a connection.
- If you change `sw.js` caching rules, bump the cache names in it.
