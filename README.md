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

Libraries (CDN): Leaflet 1.9.4, Leaflet.Draw, leaflet-pip, SheetJS `xlsx` 0.18.5, `@supabase/supabase-js` v2.

## Data model
Route files are Excel/CSV; only the **first sheet** is read. One row = one stop.

| Column | Use |
|---|---|
| `LATITUDE`, `LONGITUDE` | Marker position (rows without them are skipped) |
| `ROUTE`, `DAY` | Route id and weekday number 1-7 (Monday=1); grouping, filters, colors. `NEWROUTE`/`NEWDAY` are ignored |
| `CSADR#`, `CSSDIR`, `CSSTRT`, `CSSFUX` | Address parts (number, direction, street, suffix) |
| `SIZE`, `QTY`, `BINNO` | Shown in popup / chooser |
| `del_status` | `"Delivered"` (case-insensitive) = done; empty = pending |

Saved files live in the Supabase storage bucket `excel-files`. Files named like "route summary" are ignored (the old Route Summary panel was removed).

## Key runtime state (`app.js`)
- `window._currentRows / _currentWorkbook / _currentFilePath`: the loaded file; used when saving.
- `routeDayGroups["ROUTE|DAY"]` and `["ROUTE|Delivered"]` = `{ layers: [markers] }`; drives filter checkboxes (`buildRouteDayLayerControls`) and visibility (`applyFilters`).
- Each marker: `marker._rowRef` (its row object), `marker._base` (`{lat, lon, symbol}`).
- Selection: `drawnLayer` (polygon/rectangle), `individuallySelectedMarkers`, `individuallyDeselectedMarkers`. **A stop is selected iff** it is in the first set, or inside the drawn shape and not in the second. Always use `isStopSelected(marker, tester)` (`createSelectionTester()` builds the polygon test once).
- `mobileStopSelectionMode`: phone tap-selection mode flag.
- `localStorage`: `cartdelivery.savedFiles.cartDelivery` (names for the Cart Delivery tab; per browser, not shared), `sunMode` (`on`/`off`).

## Main flows
1. **Open file**: saved-files modal (`listFiles`) or upload (`uploadFile`) -> `processExcelBuffer(buffer)` clears old state and builds markers. The modal opens on the **Cart Delivery** tab.
2. **Select**: desktop clicks markers or draws polygons; phone uses **Select Stops** mode. `handleMobileStopTap` selects the nearest stop, or shows the chooser when the two nearest are within 12px. Finish with **Done**.
3. **Mark delivered / undo**: `saveSelectedDeliveryStatus(markDelivered)` uploads the whole workbook with `del_status` changed; only after success does it update rows, move markers to the `|Delivered` group and refresh controls. Status shows in `#deliverySaveStatus` via `setDeliverySaveStatus`.
4. **Layout**: `placeDeliveryControls()` moves the same buttons between the phone dock (below the map) and the desktop sidebar at 900px. `syncMobile*Layout` publishes `--mobile-controls-height` / `--mobile-header-height` CSS variables through a `ResizeObserver`.
5. **Location**: Locate (follow GPS + heading); Copy Location (nearby addresses + coordinates for truck handoffs).

## How-to recipes
- **New shared button**: add it in `index.html`, place it in both branches of `placeDeliveryControls()`, style both layouts.
- **Different route/day column names**: change only `rowRoute()` / `rowDay()` in `app.js`; every other place (grouping, nearby-stop chooser, delivered save) reads route/day through them. Never read `row.ROUTE`/`row.DAY` directly.
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

## Testing
Build a small workbook in the browser console (`XLSX.utils.json_to_sheet`) and call `processExcelBuffer(...)` at 440x956 and desktop widths. Check: direct tap selects, overlapping tap opens the chooser, polygon + single deselect, Done, no horizontal scroll, no console errors. Don't save to the real bucket while testing.
