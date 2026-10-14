const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html'));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, hasTouch: true, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host.endsWith('supabase.co') || host === 'api.optimoroute.com') return route.fulfill({ contentType: 'application/json', body: '[]' });
      if (/arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(host)) return route.abort();
      return route.continue();
    });
    await context.addInitScript(() => {
      window.gpsMode = 'ready'; window.gpsAccuracy = 12; window.gpsAge = 0;
      window.gpsWatches = new Map(); window.gpsPending = []; let nextWatch = 0;
      window.gpsResult = () => ({ coords: { latitude: 30.101881, longitude: -97.756653, accuracy: gpsAccuracy }, timestamp: Date.now() - gpsAge });
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
        getCurrentPosition(success, failure) {
          if (gpsMode === 'hold') { gpsPending.push(success); return; }
          setTimeout(() => gpsMode === 'fail' ? failure({ code: 1 }) : success(gpsResult()), 0);
        },
        watchPosition(success) { const id = ++nextWatch; gpsWatches.set(id, success); return id; },
        clearWatch(id) { gpsWatches.delete(id); }
      } });
      window.copied = []; window.shared = []; window.shareMode = 'ready'; window.clipboardMode = 'ready';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) {
        if (clipboardMode === 'fail') throw new Error('Unavailable');
        if (clipboardMode === 'hold') await new Promise(resolve => { window.finishClipboard = resolve; });
        copied.push(text);
      } } });
      window.fakeShare = async data => {
        if (shareMode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
        if (shareMode === 'fail') throw new Error('Unavailable');
        shared.push(data);
      };
      Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: fakeShare });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const createMap = L.map;
      L.map = (...args) => { const result = createMap(...args); if (args[0] === 'locationPreviewMap') window.testPreview = result; return result; };
      const rows = [{ ROUTE: 'A', DAY: 1, QTY: 3, LATITUDE: 30.101, LONGITUDE: -97.756, BINNO: 'sample' }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      _currentFilePath = 'Sample.xlsx'; processExcelBuffer(null, wb, rows);
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers)[0];
      individuallySelectedMarkers.add(marker); updateSelectionCount(); updateUndoButtonState();
      window.deliverySnapshot = () => JSON.stringify({ rows: _currentRows, layers: layerVisibilityState, center: map.getCenter(), zoom: map.getZoom(),
        selected: Object.values(routeDayGroups).flatMap(g => g.layers).filter(m => isStopSelected(m)).length, tracking: watchId });
    });
    const open = async () => {
      await page.evaluate(() => document.getElementById('copyLocationBtn').click());
      await page.waitForFunction(() => document.getElementById('copyLocationDialog').dataset.locationState === 'ready');
    };
    const refresh = async () => {
      await page.locator('#updateCopyLocationBtn').click();
      await page.waitForFunction(() => document.getElementById('copyLocationDialog').dataset.locationState === 'ready');
    };
    const close = async () => {
      const closed = page.evaluate(() => new Promise(resolve => document.getElementById('copyLocationDialog').addEventListener('close', () => resolve(), { once: true })));
      await page.locator('#closeCopyLocationBtn').click();
      await closed;
      await page.waitForFunction(() => gpsWatches.size === 0);
    };
    const stale = async () => {
      assert.equal(await page.locator('#copyLocationDialog').getAttribute('data-location-state'), 'stale');
      for (const id of ['copyCoordinatesBtn', 'copyMapLinkBtn', 'shareLocationBtn']) assert(await page.locator('#' + id).isDisabled());
      assert.equal(await page.locator('#verifyLocationLink').getAttribute('href'), null);
      assert(await page.locator('#updateCopyLocationBtn').isEnabled());
    };
    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [true, false]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await page.waitForTimeout(350);
        const before = await page.evaluate(() => deliverySnapshot());
        await open();
        assert.equal(await page.locator('#nearbyLocationAddress').count(), 0);
        assert.equal(await page.locator('#copyLocationDialog .route-context').count(), 0);
        assert.equal(await page.locator('#currentCoordinates').inputValue(), '30.101881, -97.756653');
        const point = await page.evaluate(() => {
          const circle = Object.values(testPreview._layers).find(layer => layer instanceof L.Circle);
          return { ...circle.getLatLng(), radius: circle.getRadius() };
        });
        assert.deepEqual(point, { lat: 30.101881, lng: -97.756653, radius: 12 });
        assert.equal(await page.locator('#locationPreviewMap .leaflet-control-attribution').evaluate(el => getComputedStyle(el).fontSize), '10px');
        const verify = new URL(await page.locator('#verifyLocationLink').getAttribute('href'));
        assert.equal(verify.searchParams.get('query'), '30.101881,-97.756653');
        await page.locator('#copyMapLinkBtn').click();
        const link = new URL(await page.evaluate(() => copied.at(-1)));
        assert.equal(link.pathname, '/maps/dir/');
        assert.equal(link.searchParams.get('destination'), verify.searchParams.get('query'));
        assert.equal(link.searchParams.get('origin'), null);
        assert.equal(link.searchParams.get('dir_action'), 'navigate');
        await page.locator('#shareLocationBtn').click();
        assert.equal(await page.evaluate(() => shared.at(-1).url), link.toString());
        await page.evaluate(() => testPreview.panBy([40, 20], { animate: false }));
        assert.equal(await page.locator('#currentCoordinates').inputValue(), '30.101881, -97.756653');
        await page.locator('#recenterLocationPreviewBtn').click();
        assert.equal(await page.evaluate(() => deliverySnapshot()), before);
        assert(await page.locator('#copyLocationDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        for (const id of ['shareLocationBtn', 'copyCoordinatesBtn', 'copyMapLinkBtn', 'updateCopyLocationBtn', 'recenterLocationPreviewBtn']) assert((await page.locator('#' + id).boundingBox()).height >= 44);
        await page.locator('#copyLocationDialog').screenshot({ path: path.join(root, `local-artifacts/location-sharing-${width}-${light}.png`) });
        await page.evaluate(() => { gpsWatches.forEach(callback => callback({ coords: { latitude: 30.1019, longitude: -97.75665, accuracy: 12 }, timestamp: Date.now() + 1 })); });
        assert.equal(await page.locator('#copyLocationDialog').getAttribute('data-location-state'), 'ready', 'GPS jitter does not invalidate a fix');
        await page.evaluate(() => { gpsWatches.forEach(callback => callback({ coords: { latitude: 30.104, longitude: -97.756, accuracy: 12 }, timestamp: Date.now() + 1 })); });
        await stale();
        await page.locator('#copyLocationDialog').screenshot({ path: path.join(root, `local-artifacts/location-sharing-stale-${width}-${light}.png`) });
        const target = await page.locator('#locationPreviewMap').evaluate(el => {
          const box = el.getBoundingClientRect(), point = L.point(box.width * .6, box.height * .3);
          const latlng = testPreview.containerPointToLatLng(point).wrap();
          window.oldLocationWatch = [...gpsWatches.values()][0];
          return { x: box.x + point.x, y: box.y + point.y, lat: latlng.lat.toFixed(6), lng: latlng.lng.toFixed(6) };
        });
        if (width <= 900) await page.touchscreen.tap(target.x, target.y);
        else await page.mouse.click(target.x, target.y);
        assert.equal(await page.locator('#copyLocationDialog').getAttribute('data-location-state'), 'manual');
        assert.match(await page.locator('#locationSource').textContent(), /map-selected location.*Replaces GPS/);
        const chosen = await page.locator('#currentCoordinates').inputValue();
        const parts = chosen.split(',').map(Number);
        assert(Math.abs(parts[0] - Number(target.lat)) < .00001 && Math.abs(parts[1] - Number(target.lng)) < .00001);
        assert.equal(await page.locator('#currentCoordinatesLabel').textContent(), 'Map-selected latitude, longitude');
        assert.equal(await page.locator('#updateCopyLocationBtn').textContent(), 'Use GPS instead');
        assert.equal(await page.evaluate(() => gpsWatches.size), 0);
        assert.equal(await page.evaluate(() => Object.values(testPreview._layers).filter(layer => layer instanceof L.Circle).length), 0, 'Manual point has no GPS accuracy circle');
        await page.locator('#copyCoordinatesBtn').click();
        assert.equal(await page.evaluate(() => copied.at(-1)), chosen);
        await page.locator('#copyMapLinkBtn').click();
        const pickedLink = new URL(await page.evaluate(() => copied.at(-1)));
        assert.equal(pickedLink.searchParams.get('destination'), chosen.replace(/\s/g, ''));
        assert.equal(new URL(await page.locator('#verifyLocationLink').getAttribute('href')).searchParams.get('query'), pickedLink.searchParams.get('destination'));
        await page.locator('#shareLocationBtn').click();
        assert.equal(await page.evaluate(() => shared.at(-1).url), pickedLink.toString());
        assert.match(await page.evaluate(() => shared.at(-1).text), /chose this point manually instead of using GPS/);
        await page.evaluate(() => { testPreview.panBy([20, 0], { animate: false }); oldLocationWatch({ coords: { latitude: 31, longitude: -98, accuracy: 5 }, timestamp: Date.now() + 1 }); });
        assert.equal(await page.locator('#currentCoordinates').inputValue(), chosen);
        assert.equal(await page.evaluate(() => deliverySnapshot()), before);
        await page.locator('#copyLocationDialog').screenshot({ path: path.join(root, `local-artifacts/location-sharing-picked-${width}-${light}.png`) });
        await refresh();
        assert.equal(await page.locator('#currentCoordinates').inputValue(), '30.101881, -97.756653');
        assert.equal(await page.locator('#locationSource').textContent(), 'Using GPS location');
        assert.equal(await page.locator('#updateCopyLocationBtn').textContent(), 'Update Location');
        await close();
        assert.equal(await page.evaluate(() => gpsWatches.size), 0);
      }
    }
    await open();
    await page.evaluate(() => { shareMode = 'cancel'; }); await page.locator('#shareLocationBtn').click();
    assert(await page.locator('#shareLocationBtn').isEnabled());
    await page.evaluate(() => { shareMode = 'fail'; }); await page.locator('#shareLocationBtn').click();
    assert.match(await page.locator('#copyLocationStatus').textContent(), /Use Copy Directions Link/);
    await page.evaluate(() => { navigator.share = undefined; }); await page.locator('#shareLocationBtn').click();
    assert.match(await page.locator('#copyLocationStatus').textContent(), /Directions link copied/);
    await page.evaluate(() => { clipboardMode = 'fail'; }); await page.locator('#copyMapLinkBtn').click();
    assert(await page.locator('#manualLocationCopy').isVisible());
    assert.match(await page.locator('#manualLocationText').inputValue(), /destination=30.101881%2C-97.756653/);
    await page.clock.install(); await page.clock.fastForward(61000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await stale(); assert.equal(await page.locator('#manualLocationCopy').isVisible(), false);
    await page.locator('#locationPreviewMap').focus();
    await page.keyboard.press('ArrowRight');
    await page.clock.runFor(300);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#copyLocationDialog').getAttribute('data-location-state'), 'manual', 'Keyboard users can choose the map center');
    const fixedPoint = await page.locator('#currentCoordinates').inputValue();
    await page.clock.fastForward(61000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.locator('#copyLocationDialog').getAttribute('data-location-state'), 'manual', 'A chosen fixed point does not expire with GPS');
    assert.equal(await page.locator('#currentCoordinates').inputValue(), fixedPoint);
    assert(await page.locator('#shareLocationBtn').isEnabled());
    await page.evaluate(() => { gpsMode = 'fail'; });
    await page.locator('#updateCopyLocationBtn').click(); await page.clock.runFor(20);
    await stale(); assert.match(await page.locator('#copyLocationStatus').textContent(), /permission/);
    await page.evaluate(() => { gpsMode = 'ready'; gpsAccuracy = 150; });
    await page.locator('#updateCopyLocationBtn').click(); await page.clock.runFor(20);
    assert.match(await page.locator('#copyLocationStatus').textContent(), /GPS is approximate/);
    await page.evaluate(() => { gpsAccuracy = NaN; });
    await page.locator('#updateCopyLocationBtn').click(); await page.clock.runFor(20); await stale();
    await page.evaluate(() => { gpsAccuracy = 12; gpsAge = 61000; });
    await page.locator('#updateCopyLocationBtn').click(); await page.clock.runFor(20); await stale();
    await page.evaluate(() => { gpsAge = 0; gpsMode = 'hold'; });
    await page.locator('#updateCopyLocationBtn').click();
    await close();
    await page.evaluate(() => { gpsMode = 'ready'; document.getElementById('copyLocationBtn').click(); });
    await page.clock.runFor(20);
    await page.evaluate(() => gpsPending.splice(0).forEach(callback => callback({ coords: { latitude: 1, longitude: 2, accuracy: 12 }, timestamp: Date.now() })));
    assert.equal(await page.locator('#currentCoordinates').inputValue(), '30.101881, -97.756653', 'Closed requests cannot overwrite a new fix');
    await close(); assert.equal(await page.evaluate(() => gpsWatches.size), 0);
    assert.deepEqual(errors, []);
    console.log('PASS location preview, directions payload, sharing/copy fallbacks, expiry, movement, refresh, bad GPS, cleanup, phone/desktop themes, and unchanged delivery state');
  } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
