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
| `SIZE`, `BINNO` | Container details in the stop popup; `BINNO` also appears on its own labeled line in each Choose a stop entry |
| `QTY` | Cart quantity in the popup; finite numeric values greater than 1 also get a map badge and a quantity hint in the nearby-stop chooser |
| `SEQNO` | Optional finite, nonnegative number or numeric text (zero allowed); shown in popup/chooser and the sequence overlay |
| `del_status` | `"Delivered"` (case-insensitive) = done; empty = pending |

Saved files live in the Supabase storage bucket `excel-files`. Files named like "route summary" are ignored (the old Route Summary panel was removed).

## Key runtime state (`app.js`)
- `window._currentRows / _currentWorkbook / _currentFilePath`: the loaded file; used when saving.
- `routeDayGroups["ROUTE|DAY"]` and `["ROUTE|Delivered"]` = `{ layers: [markers] }`; drives filter checkboxes (`buildRouteDayLayerControls`) and visibility (`applyFilters`).
- Each marker: `marker._rowRef` (its row object), `marker._base` (`{lat, lon, symbol}`).
- Multiple carts: `multiCartQuantity(row)` accepts numeric `QTY` or numeric text greater than 1. `attachQuantityBadge(marker, row)` attaches a noninteractive `marker._quantityBadge` in `quantityPane` above the Canvas stops. Its add/remove events follow the stop's visibility; it is not part of selection or marker counts. `quantityBadgesToggle` hides/shows the pane without changing stop layers.
- Stop search: markers lazily cache `_addressSearch` address tokens and normalized bin identifiers. `addressSearchTokens()` normalizes text/abbreviations; `addressSearchScore()` ranks address matches, while `binSearchText()` matches bin identifiers separately. `initApp()` owns search filters, totals, the result list, and a separate noninteractive preview ring. `resetAddressSearch()` clears them on file load/reset; `refreshAddressSearch()` rebuilds scope options and updates results after map filters and confirmed delivery changes.
- Selection: `drawnLayer` (polygon/rectangle), `individuallySelectedMarkers`, `individuallyDeselectedMarkers`. **A stop is selected iff its marker is visible** and either it is in the first set or it is inside the drawn shape and not in the second. Always use `isStopSelected(marker, tester)` (`createSelectionTester()` builds the polygon test once).
- `sequenceGroups`: a `Map` keyed by `JSON.stringify([route, day])`, separate from marker groups. Each group contains `{ route, day, stops }`; each stop holds `{ row, seq, index, latlng }`, with `latlng: null` for an invalid location. Row references are shared with `_currentRows`, so confirmed delivery changes update styling without changing sequence order.
- `mobileStopSelectionMode`: phone tap-selection mode flag.
- `localStorage`: `cartdelivery.savedFiles.cartDelivery` (local cache of the Cart Delivery tab list; the real, shared list is the hidden bucket file `_cart-delivery-tab.json`, see `SHARED_TAB_FILE`), `sunMode` (`on`/`off`), `cartdelivery.quantityBadges` (`on`/`off`, defaults to on).

## Main flows
1. **Open file**: saved-files modal (`listFiles`) or upload (`uploadFile`) -> `processExcelBuffer(buffer)` clears old state and builds markers. The modal opens on the **Cart Delivery** tab.
2. **Select**: desktop clicks markers or draws polygons; phone uses **Select Stops** mode. `handleMobileStopTap` selects the nearest stop, or shows the chooser when the two nearest are within 12px. Finish with **Done**. With Select Stops off, a phone tap only opens the customer details popup (no selection).

   **Choose a stop** lists each record's `BINNO` on a separate **Bin #:** line beneath the address, making overlapping addresses easier to distinguish. Numeric zero is displayed, text identifiers retain leading zeros, and blank/missing values say **Not provided**. Bin values are displayed as text and long values wrap within the entry.
3. **Mark delivered / undo**: `saveSelectedDeliveryStatus(markDelivered)` uploads the whole workbook with `del_status` changed; only after success does it update rows, move markers to the `|Delivered` group and refresh controls. Status shows preparation/upload stages, payload size and elapsed seconds in `#deliverySaveStatus`. **Data trust rule: markers/rows change only after a confirmed upload; never make this optimistic.** `serializeDeliveryWorkbook` generates Excel bytes, then repacks the ZIP entries with fflate level 6 (asynchronous compression for large entries). It falls back to SheetJS compression if fflate is unavailable, fails, or exceeds 20 seconds. No worksheet entries are removed. This reduces network traffic but still uploads the full workbook, so connection speed and file size matter. `window.lastDeliverySaveMetrics` records the latest upload's bytes, preparation/upload milliseconds and confirmation flag, without row data.
4. **Layout**: `placeDeliveryControls()` moves the same buttons between the phone dock (below the map) and the desktop sidebar at 900px. `syncMobile*Layout` publishes `--mobile-controls-height` / `--mobile-header-height` CSS variables through a `ResizeObserver`.
5. **Location**: Locate (follow GPS + heading); Copy Location (nearby addresses + coordinates for truck handoffs).
6. **Sequence arrows**: open **Menu → Delivery overlays** on phones (**Delivery overlays** in the left sidebar on desktop), enable **Sequence arrows**, and choose all sequences or a route/day. Original paths include delivered stops and remain independent of marker visibility. See [Sequence overlay](#sequence-overlay) for styling and data rules.
7. **Truck / trailer loads**: open **More → Truck / Trailer Loads** on phones (right sidebar on desktop). Choose or create a shared truck count profile, such as **Burnet**. Manually record a load only after the crew finishes unloading it: truck/trailer, optional vehicle name, unloading date/time, approximate trash and recycling quantities. Each trip counts once. Profiles are independent of route files and cart delivery order. All-date or today totals exclude voided entries; today uses the viewing phone's local date. A mistaken load can be voided and replaced; its history remains visible.

### Basemaps, city limits and address numbers

**Map View** offers OpenStreetMap streets, Esri satellite imagery, Esri Imagery Clarity, Esri minimal light/dark gray streets, and Austin local aerials. The minimal views use Esri rather than CARTO so no CARTO API key is required. Clarity can show older imagery. Austin aerials have regional coverage, with an inline notice outside their footprint. The city's cached tiles and gray maps use native zoom 16 and scale at closer zooms; normal satellite/Clarity use native zoom 19. Closer zooms do not imply newer or higher-resolution imagery.

`setBaseMap()` is the single basemap switch handler. It removes the previous layer before adding the selected one; inactive basemaps are not prefetched. All tile layers load after movement settles, skip intermediate zoom loading, and keep a one-tile buffer. A single transportation-label layer accompanies aerial views at zoom 15 or closer. Provider credits use compact 1px text at the upper right on phones and lower left on desktop, clear of the delivery controls and desktop action panel. They do not intercept pointer taps; provider links remain keyboard-accessible. The optional Leaflet branding prefix is omitted. `placeMapCredits()` updates their corner when crossing the 900px layout breakpoint. Map view changes do not change stop selection, filters, colors, sequence, or delivery data.

Expand **Map overlays** and enable **City limits** to show pink outlines of incorporated cities/towns and city names over any Map View. It defaults off each session, covers U.S. incorporated places (including Texas), and does not show unincorporated census-designated places or ETJs. The [Census TIGERweb service](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/28) supplies reference boundaries, which can lag recent annexations. Names appear where the service's scale/label placement allows them; an empty view can mean no city edge crosses the viewport.

`cityLimitsLayer` uses Leaflet's built-in WMS tile layer with incorporated-place outlines and names (WMS layers 49/48, verified in GetCapabilities; these differ from REST IDs 28/29), transparent 512px image tiles, no retained offscreen buffer, no world wrapping, and loading only after movement settles. It requests nothing while disabled or below zoom 9. Its noninteractive `cityLimitsPane` sits below address numbers, sequence arrows, and stop markers; toggling it or switching basemaps preserves stop selection, filters and delivery data. Tile failures appear inline with an off/on retry. No boundary polygons or extra libraries are downloaded. Census GetMap images share the existing bounded 600-tile service-worker cache and refresh in the background.

Expand **Map overlays** and enable **Address numbers** for Austin-area city address points. It defaults off each session, works with any basemap, and displays house numbers rather than customer/bin data. It is separate from the loaded route file, is not selectable, and hides while selecting stops on phones or drawing/editing shapes. Outside the Austin area, below zoom 18, or while disabled/paused, it makes no address requests. Empty views and service failures appear inline.

`CityAddressNumbers` renders one noninteractive canvas in `addressNumberPane` below stop markers. After a 400ms pause, it queries the current viewport plus a small margin from the [Austin address service](https://maps.austintexas.gov/gis/rest/Shared/Property/MapServer/0), requests only address-number fields and coordinates, and caps responses at 400 features. Grid collision checks limit drawing to 120 labels on phones / 220 on desktop, with device pixel ratio capped at 2. No per-address markers/tooltips or citywide downloads are created. Panning/zooming cancels pending work and hides old labels; stale responses cannot replace the current view. Requests time out after eight seconds. Up to six viewport results are cached in memory for two minutes and discarded when disabled. Status/quantity saves never change this reference data.

Sources: [Esri Imagery Clarity](https://www.esri.com/about/newsroom/arcwatch/learn-how-to-use-world-imagery-clarity-as-your-basemap), [Esri light gray map](https://doc.arcgis.com/en/data-appliance/7.2/maps/world-light-gray-base.htm), [Austin aerial service](https://maps.austintexas.gov/gis/Image/MapTiled/AerialImagery_WebMercator/MapServer). The aerial service's description and layer-year labels differ; the app intentionally does not claim an acquisition year. Coverage, tile detail, and address completeness vary by location.

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

### Multiple-cart indicators

Stops with `QTY > 1` automatically show an amber **×2**, **×3**, etc. badge beside their marker while panning or zooming, in both themes and with Street Labels off. Numeric text such as `"2"` also works. Blank, invalid, nonfinite, or quantity values of 1 or less have no badge. The number is the row's total required carts, not a remaining-cart estimate.

Expand **Delivery overlays** in **Menu** on phones or the left sidebar on desktop, then turn **Show quantity badges** on/off. This section groups quantity badges and Sequence arrows; city limits and address numbers stay in the separate **Map overlays** section. Both dropdowns start closed and open independently. Closing either keeps its selected overlays active. Quantity badges default to on and remember the choice in this browser across reloads and file changes. The toggle controls only the badges; quantities remain available in stop details and the nearby-stop chooser.

When enabled, badges stay visible during selection, preserve route and delivery marker colors, and appear only when their stop marker is visible. Hidden delivered markers have no quantity badge; showing the delivered layer brings it back. Badges follow confirmed delivery/undo visibility changes, and file changes or Reset Map remove the old badges. They do not intercept map gestures or add selectable records.

### Address search

Search the loaded file by house number, street, or a combination (for example, `1234`, `Oak`, or `1234 N Oak St`). Results update after a short typing pause; Search or Enter runs immediately. Search ignores case, extra spaces, accents, and punctuation, and recognizes common direction/street abbreviations (`N`/`North`, `St`/`Street`, `Rd`/`Road`, etc.). Query words can appear in any order. Partial street names match; house numbers match exactly or from the start, so `123` can find `1234` but not `9123`. Exact house numbers rank first, with full address matches highest and natural address ordering for ties.

`BINNO` is searchable in the same box (optionally prefixed with `Bin`). Bin matching ignores case, spaces, and separators, supports exact or starting-prefix matches, and does not apply address abbreviations. Exact bin matches rank above address matches. Leading zeros are preserved when the spreadsheet stores the identifier as text.

**All**, **Pending**, and **Delivered** choose delivery status; **Multiple carts** is an independent `QTY > 1` toggle that can combine with either status. All resets status and the multiple-cart toggle, retaining the route/day scope. Expand **Route / day** to choose original routes and days from the loaded stops, including delivered stops' original days. These controls narrow only search results and leave map filters and selection unchanged. Filters work without a typed query; Search or All with an empty box browses all stops in the selected scope.

The cart summary counts every matching stop, including matches beyond the displayed page and hidden layers. **Carts remaining** sums only pending stops' finite, nonnegative numeric `QTY` values (numeric text and zero are accepted). Blank, invalid, negative, or nonfinite quantities are not assumed to mean one cart: the summary labels the known cart subtotal and reports how many pending stops are missing QTY. Delivered stops contribute to the stop count but not remaining carts. Confirmed saves/undo refresh filters, result status, and totals; failed or unfinished saves leave them unchanged.

Results include all stop markers in the current file, including hidden and delivered layers. Each result shows its address, original route/day, sequence/bin when present, quantity, delivery status, and a **Hidden layer** hint where applicable. The list starts with 50 results and offers **Show more** in batches of 50. No-match and missing-file messages appear inline.

Clicking a result centers the map, closes Menu on phones, and shows a blue preview ring and details. This separate preview leaves marker filters, route/delivery colors, and delivery selection unchanged; hidden stops remain hidden in their regular layers. Stop-selection mode retains its existing popup suppression on phones. Changing the query or search filters removes the preview. Emptying the query keeps active filters; otherwise it hides results. Clear, Escape, loading another file, or Reset Map clears the query, search filters, totals, and preview. Search state is not saved to the workbook or localStorage.

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
- **Map overlay controls**: quantity and sequence controls share **Delivery overlays** (`#deliveryOverlaysSection`); city limits and address numbers share **Map overlays** (`#mapOverlaysSection`). These independent native `details`/`summary` disclosures start closed, open with a tap, Enter, or Space, and only hide sidebar controls, preserving overlay state. Both use `.map-overlays` and `.map-overlay-content` for shared styling. The inner `.map-overlay-card` rows use visual examples and switches backed by native checkboxes. Keep the existing input IDs, accessible descriptions, 44px targets, keyboard focus, and disabled sequence state. Scoped theme colors override the earlier sidebar-wide light-theme rules.
- **New spreadsheet column in popups**: extend `popupContent` in `processExcelBuffer` (and `showNearbyStopPicker` if relevant).
- **Tap sensitivity**: `getNearbyVisibleStops` (hit radius) and `handleMobileStopTap` (12px ambiguity threshold).
- **Stop matching**: extend `ADDRESS_SEARCH_ALIASES`, `addressSearchTokens()`, `addressSearchScore()`, or `binSearchText()`; caches contain only stable address/bin fields. Read current status and quantity directly from rows, and route/day via `rowRoute()`/`rowDay()`. Render spreadsheet text with `textContent`. Keep search navigation separate from `isStopSelected()` and real marker styling.
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

For quantity badges, include `QTY` values of 1, 2, `"3"`, blank, and invalid text. Verify the count badges follow their stops during pan/zoom, selection, marker filtering, confirmed delivery/undo, file changes, and Reset Map. Turn **Show quantity badges** off/on and verify selection is unchanged, filtered-out stops stay hidden, and the preference survives reload. Check both themes with Street Labels off and on; taps and polygon selection should still select only the original stop records.

For address search, test exact/prefix house numbers, partial streets, reversed query words, direction/suffix abbreviations, punctuation, and extra spaces. Include duplicate addresses on different routes, hidden delivered stops, and more than 50 matches. Verify live results, Enter, Show more, inline no-match messages, keyboard result buttons, and Clear/Escape. Opening a hidden result must preserve filters, selection, and original marker colors; confirmed delivery changes refresh its status. File changes/reset must clear results and the preview. Test both themes at phone and desktop sizes with fake cloud saves.

For search filters/totals, test exact/prefix bin numbers with separators, case differences, numeric values, and text leading zeros. Combine status, multiple carts, route, and original day (including delivered stops); verify blank-query browsing and independence from map filters. Totals must include all pages, exclude delivered quantities, accept numeric text/zero, and flag missing/invalid pending quantities. Test delayed/failed/confirmed saves and undo, cleared/reset filters, stale route options after file changes, and 44px targets in both themes/layouts.

For basemaps/address numbers, switch every Map View while a stop is selected; verify one basemap, one aerial-label layer at most, and unchanged marker visibility/colors/selection. Check local coverage notices, native tile zoom caps, and phone/desktop layouts in both themes. With a fake city-query endpoint, verify no requests while off/zoomed out/outside coverage/selecting/drawing; bounded viewport queries, label limits and collision avoidance; rapid-pan cancellation/stale responses, cache reuse, failed requests, and disabling while a request is pending. Check service-worker tile routing keeps city queries out of caches and new providers within the 600-tile cache. Never allow test writes to real storage.

For city limits, verify no Census requests by default or below zoom 9; enable it and inspect outlines/names around Burnet or Austin on streets, minimal maps and satellite. Check transparent image tiles only, the 512px tile size/no buffer, and unchanged stops/selection through basemap switches, panning and off/on. Confirm map taps and drawing pass through the boundary pane, loading/error/retry messages, off during pending requests, and 44px toggle targets with both themes at phone and desktop sizes. Check Census GetMap images route to the bounded tile cache rather than the shell cache; unrelated Census URLs must not count as tiles.

- **Polygon drawing on touch**: Leaflet.Draw's `_onTouch` is overridden in `app.js` (above `drawControl`) so a vertex is added only on a quick, non-moving, single-finger tap; panning/pinching while drawing adds no points.

- **Closing polygons**: while drawing, the first point turns green/large and a **Finish Shape** / **Cancel** bar appears at the top of the map after 3 points (`EASIER SHAPE CLOSING` in `app.js`, `#drawActionBar` in `style.css`).


## Install as a home-screen app (PWA)

On iPhone: open the site in Safari, tap Share, then **Add to Home Screen**. It opens full-screen with its own icon.

- Files: `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`. The service worker is registered at the end of `app.js`.
- App files use network-first (updates arrive immediately, cached copy only when offline). Map tiles from OpenStreetMap, Esri, Clarity, Austin aerials, and Census city limits share a bounded cache (up to 600) for faster/offline panning. City address queries bypass service-worker caches; their small viewport cache exists only in memory.
- Supabase requests are **never** cached, so delivery data is always live. Saving still requires a connection.
- If you change `sw.js` caching rules, bump the cache names in it.
