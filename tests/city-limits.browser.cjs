const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

const collection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { GEOID: 'TEST', NAME: 'Sample city' }, geometry: { type: 'Polygon', coordinates: [
  [[-98.24,30.74],[-98.22,30.74],[-98.22,30.76],[-98.24,30.76],[-98.24,30.74]],
  [[-98.235,30.744],[-98.235,30.748],[-98.231,30.748],[-98.231,30.744],[-98.235,30.744]]
] } }] };

(async () => {
  const handlers = {}, cacheNames = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
    self: { addEventListener: (name, handler) => { handlers[name] = handler; } }, URL,
    caches: { open: async name => { cacheNames.push(name); return { match: async () => null }; } },
    fetch: async () => ({ status: 503 })
  });
  let response;
  handlers.fetch({ request: { method: 'GET', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/28/query?f=geojson' }, respondWith: () => { throw new Error('Live boundary query must bypass service worker'); } });
  handlers.fetch({ request: { method: 'GET', url: 'https://tigerweb.geo.census.gov/arcgis/services/TIGERweb/tigerWMS_Current/MapServer/WMSServer?request=GetMap&layers=48' }, respondWith: value => { response = value; } });
  await response;
  assert.deepEqual(cacheNames, ['cartdelivery-tiles-v5']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, hasTouch: true, serviceWorkers: 'block' });
    let mode = 'success', requests = 0, release;
    const queryParams = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('supabase.co') || url.hostname === 'api.optimoroute.com') return route.fulfill({ contentType: 'application/json', body: '[]' });
      if (url.hostname === 'tigerweb.geo.census.gov') {
        if (process.env.LIVE_CITY_LIMITS === '1') return route.continue();
        if (url.pathname.endsWith('/query')) {
          requests++;
          queryParams.push(Object.fromEntries(url.searchParams));
          if (mode === 'hold') await new Promise(resolve => { release = resolve; });
          if (mode === 'failure') return route.fulfill({ status: 503, body: 'Unavailable' });
          const data = mode === 'empty' ? { type: 'FeatureCollection', features: [] } : mode === 'limit' ? { ...collection, exceededTransferLimit: true } : collection;
          return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(data) });
        }
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64') });
      }
      if (/tile|arcgisonline|arcgis\.com|maps\.austin/.test(url.hostname) && process.env.LIVE_CITY_LIMITS !== '1') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ ROUTE: 'TEST', DAY: 1, QTY: 3, SEQNO: 1, LATITUDE: 30.75, LONGITUDE: -98.23 }]), 'Stops');
      processExcelBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      map.setView([30.75, -98.23], 13, { animate: false });
      window.testMarker = Object.values(routeDayGroups).flatMap(group => group.layers)[0];
      individuallySelectedMarkers.add(testMarker); updateSelectionCount(); updateUndoButtonState();
    });
    const toggle = value => page.evaluate(value => { cityLimitsToggle.checked = value; cityLimitsToggle.dispatchEvent(new Event('change')); }, value);
    const ready = () => page.waitForFunction(() => cityLimitsPolygons.getLayers().length > 0);
    const state = () => page.evaluate(() => ({ rows: JSON.stringify(window._currentRows), selected: isStopSelected(testMarker), visible: map.hasLayer(testMarker), color: testMarker.options.color }));
    const original = await state();
    if (process.env.LIVE_CITY_LIMITS === '1') {
      await toggle(true); await ready();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(root, 'local-artifacts/city-limits-live-burnet.png') });
      await page.evaluate(() => { const option = [...document.getElementById('baseMapSelect').options].find(option => /Satellite/.test(option.text)); setBaseMap(option.value); });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(root, 'local-artifacts/city-limits-live-burnet-satellite.png') });
      console.log('Live Census polygons:', await page.evaluate(() => ({ count: cityLimitsPolygons.getLayers().length, names: cityLimitsPolygons.getLayers().map(layer => layer.feature.properties.NAME), status: cityLimitsStatus.textContent })));
      assert.deepEqual(await state(), original);
      assert.deepEqual(errors, []);
      return;
    }
    await page.waitForTimeout(500); assert.equal(requests, 0);
    await page.evaluate(() => map.setZoom(8, { animate: false })); await toggle(true);
    await page.waitForTimeout(500); assert.equal(requests, 0);
    await page.evaluate(() => map.setZoom(13, { animate: false })); await ready();
    assert.equal(queryParams[0].outSR, '4326');
    assert.equal(queryParams[0].resultRecordCount, '80');
    assert(queryParams[0].geometry && Number(queryParams[0].maxAllowableOffset) >= .00005);
    assert.equal(await page.evaluate(() => cityLimitsLabels.wmsParams.layers), '48');
    assert.equal(await page.evaluate(() => cityLimitsPolygons.getLayers()[0].getLatLngs().length), 2, 'Polygon holes must be retained');
    assert.equal(await page.evaluate(() => cityLimitsPolygons.getLayers()[0].options.interactive), false);
    assert.deepEqual(await state(), original);
    const loadedRequests = requests;
    await page.evaluate(() => map.panBy([1, 0], { animate: false })); await page.waitForTimeout(500);
    assert.equal(requests, loadedRequests, 'Reuse nearby viewport cache');
    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      await page.evaluate(() => map.setView([30.75,-98.23],13,{animate:false}));
      for (const light of [false, true]) {
        await page.evaluate(value => document.body.classList.toggle('sun-mode', value), light);
        for (const base of ['osm', 'satellite']) {
          await page.evaluate(value => { const select = document.getElementById('baseMapSelect'); const option = [...select.options].find(option => value === 'osm' ? /Streets \(Detailed\)/.test(option.text) : /Satellite/.test(option.text)); if (option) setBaseMap(option.value); }, base);
          await ready();
          assert.deepEqual(await state(), original);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: path.join(root, `local-artifacts/city-limits-${width}-${light}-${base}.png`) });
        }
      }
    }
    // The filled area must not intercept normal map clicks.
    await page.evaluate(() => { window.cityTestClicks = 0; map.on('click', () => window.cityTestClicks++); });
    const point = await page.evaluate(() => { const p = map.latLngToContainerPoint([30.751,-98.23]); const box = map.getContainer().getBoundingClientRect(); return { x: box.x+p.x, y: box.y+p.y }; });
    await page.mouse.click(point.x,point.y);
    assert.equal(await page.evaluate(() => window.cityTestClicks), 1);
    await toggle(false); assert.equal(await page.evaluate(() => cityLimitsPolygons.getLayers().length), 0);
    mode = 'hold'; await toggle(true);
    await page.waitForTimeout(500); assert(release);
    await toggle(false); release(); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => cityLimitsPolygons.getLayers().length), 0, 'Stale response cannot restore disabled polygons');
    mode = 'failure'; await toggle(true);
    await page.waitForFunction(() => cityLimitsStatus.textContent.includes('could not load'));
    assert.equal(await page.evaluate(() => cityLimitsPolygons.getLayers().length), 0);
    mode = 'empty'; await toggle(false); await toggle(true);
    await page.waitForFunction(() => cityLimitsStatus.textContent.includes('No incorporated'));
    mode = 'limit'; await toggle(false); await toggle(true); await ready();
    assert.match(await page.locator('#cityLimitsStatus').textContent(), /Zoom in/);
    await page.evaluate(() => map.setZoom(8,{animate:false}));
    assert.equal(await page.evaluate(() => map.hasLayer(cityLimitsLayer)), false);
    assert.deepEqual(errors, []);
    console.log('PASS: transparent filled polygons, halo/holes, viewport query/cache, disabled/zoom gating, failures/retry, stale cancellation, limits, click-through, and phone/desktop themes.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

