const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const workerHandlers = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
  self: { addEventListener: (name, callback) => { workerHandlers[name] = callback; } }, URL,
  caches: { open: () => { throw new Error('Sensitive request reached cache'); } },
  fetch: () => { throw new Error('Sensitive request was intercepted by service worker'); }
});
for (const url of ['https://api.optimoroute.com/v1/get_routes?key=fake', 'https://example.supabase.co/storage/v1/object/file'])
  workerHandlers.fetch({ request: { method: 'GET', url }, respondWith: () => { throw new Error('Sensitive request was cached'); } });
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname === '/' ? 'index.html' : new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

const sample = Array.from({ length: 8 }, (_, i) => ({
  UNIQUE: `unique-${i}`, ROUTE: i < 4 ? 'TRASH' : 'RECYCLE', DAY: i < 4 ? 1 : 2,
  NEWROUTE: 'IGNORED', NEWDAY: 7, SEQNO: [10, 2, 0, 5, 4, 2, 3, 1][i],
  LATITUDE: 30.755 + i * .001, LONGITUDE: -98.23 + i * .001,
  'CSADR#': 100 + i, CSSTRT: 'TEST', CSSFUX: 'ST', BINNO: `00${i}`, QTY: i === 0 ? 2 : 1,
  del_status: i === 3 || i === 7 ? 'Delivered' : ''
}));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 30.75, longitude: -98.23 } });
    const page = await context.newPage();
    const errors = [], calls = [];
    let mode = 'success', uploaded = [], planned = [], hold, deleteHold, planNumber = 0;
    const storedOrders = new Map();
    const scheduledRoutes = new Map();
    page.on('pageerror', error => errors.push(error.message));
    // Never allow storage writes or real Optimo calls, including failures in the test itself.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('supabase.co')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      if (url.hostname === 'api.optimoroute.com') {
        const endpoint = url.pathname.split('/').pop(), body = route.request().postDataJSON();
        calls.push({ endpoint, body, params: Object.fromEntries(url.searchParams) });
        assert.equal(url.searchParams.get('key'), 'test-key-not-real');
        let result = { success: true };
        if (endpoint === 'delete_all_orders') {
          assert.deepEqual(Object.keys(body), ['date']);
          assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
          if (mode === 'delete-hold') await new Promise(resolve => { deleteHold = resolve; });
          if (mode === 'delete-network') return route.abort();
          if (mode === 'delete-failure') result = { success: false, code: 'ERR_OPT_RUNNING' };
          else if (mode === 'delete-unconfirmed') result = {};
          else {
            for (const [id, order] of storedOrders) if (order.date === body.date) storedOrders.delete(id);
            scheduledRoutes.clear();
          }
        } else if (endpoint === 'update_drivers_parameters') {
          uploaded = [];
          result.updates = body.updates.map((update, i) => ({ success: !(mode === 'driver-failure' && i === 0), driver: update.driver, date: update.date }));
          for (const update of body.updates) {
            scheduledRoutes.delete(update.driver.externalId);
            assert.equal(update.enabled, true);
            assert.deepEqual(update.workTime, { from: '00:00', to: '23:59' });
            if (update.startLocation.type === 'custom') assert(Number.isFinite(update.startLocation.latitude));
            else assert.deepEqual(update.startLocation, { type: 'employeeDefault' });
            assert(['custom', 'employeeDefault', 'startLocation'].includes(update.endLocation.type));
            if (update.endLocation.type === 'custom') assert(Number.isFinite(update.endLocation.latitude) && Number.isFinite(update.endLocation.longitude));
          }
        } else if (endpoint === 'create_or_update_orders') {
          assert(body.orders.length <= 500);
          for (const order of body.orders) {
            assert.equal(order.duration, 0);
            assert.equal(order.location.checkInTime, 0);
            for (const field of ['load1', 'load2', 'load3', 'load4']) assert.equal(order[field], 0);
            for (const field of ['timeWindows', 'skills', 'vehicleFeatures']) assert.deepEqual(order[field], []);
          }
          uploaded.push(...body.orders);
          body.orders.forEach(order => storedOrders.set(order.orderNo, order));
          if (mode === 'hold') await new Promise(resolve => { hold = resolve; });
          result.orders = body.orders.map((order, i) => ({ orderNo: order.orderNo, success: !(mode === 'partial-upload' && i === 0) }));
        } else if (endpoint === 'start_planning') {
          assert.equal(body.includeScheduledOrders, false);
          assert.equal(body.depotTrips, false);
          assert.equal(body.useOrderObjects.length, uploaded.length);
          planned = body.useOrderObjects.map(order => storedOrders.get(order.orderNo));
          assert(planned.every(Boolean));
          assert.deepEqual(new Set(body.useDrivers.map(driver => driver.driverExternalId)), new Set(planned.map(order => order.assignedTo.externalId)));
          result.planningId = ++planNumber;
          if (mode === 'order-limit' || (mode === 'bounded' && planned.length > 700)) result = { success: false, code: 'ERR_OPT_REQUESTS_EXCEEDED' };
          else for (const driver of body.useDrivers) scheduledRoutes.set(driver.driverExternalId, planned.filter(order => order.assignedTo.externalId === driver.driverExternalId));
        } else if (endpoint === 'get_planning_status') result.status = mode === 'running' ? 'R' : 'F';
        else if (endpoint === 'get_routes') {
          const driver = url.searchParams.get('driverExternalId');
          let stops = (scheduledRoutes.get(driver) || []).slice().reverse().map((order, i) => ({ orderNo: order.orderNo, stopNumber: mode === 'gaps' ? i * 2 + 1 : i + 1 }));
          if (mode === 'missing') stops.pop();
          if ((mode === 'duplicate' || (mode === 'later-duplicate' && calls.filter(call => call.endpoint === 'start_planning').length === 2)) && stops.length > 1) stops[1] = { ...stops[0] };
          result.routes = mode === 'none' ? [] : [{ driverExternalId: driver, stops: stops.reverse() }];
        } else throw new Error(`Unexpected Optimo request: ${endpoint}`);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
      }
      if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof processExcelBuffer === 'function');
    await page.evaluate(() => {
      profileState.user = { id: 'test-profile', email: 'test@profiles.cartdelivery.invalid' };
      profileState.workspace = { mode: 'copy', owner: 'test-profile' };
    });
    const load = async (rows = sample, name = 'test.xlsx') => {
      await page.evaluate(({ rows, name }) => {
        profileState.user = { id: 'test-profile', email: 'test@profiles.cartdelivery.invalid' };
        profileState.workspace = { mode: 'copy', owner: 'test-profile' };
        window._currentFilePath = name;
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
        processExcelBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      }, { rows, name });
      await page.waitForFunction(() => phoneSequenceKey !== null);
    };
    const open = async (size = '0') => {
      await page.evaluate(() => openResequencing());
      await page.locator('#optimoKey').fill('test-key-not-real');
      await page.locator('#optimoSectionSize').selectOption(size);
    };
    const generate = async () => {
      await page.locator('#generateSequenceBtn').click();
      await page.waitForFunction(() => !resequenceBusy);
    };
    const drawnSequenceNumbers = () => page.evaluate(() => {
      const labels = [], original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        if (this.canvas.classList.contains('sequence-number-canvas')) labels.push(text);
        return original.call(this, text, ...args);
      };
      try { renderSequenceLayer(); } finally { CanvasRenderingContext2D.prototype.fillText = original; }
      return labels;
    });
    await load();
    assert.equal(await page.locator('#optimoSectionSize').inputValue(), '0');
    // Source and route choices remain visible with arrows off; choosing one shows it immediately.
    await page.locator('#mobileMenuBtn').click();
    await page.locator('#deliverySequenceDisclosure').click();
    await page.locator('[data-sequence-source="optimo"]').click();
    await page.waitForFunction(() => document.getElementById('sequenceRouteSelect').disabled);
    assert.match(await page.locator('#sequenceLayerStatus').innerText(), /No saved Optimo sequence/);
    assert.equal(await page.locator('#sequenceLayerToggle').isChecked(), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    await page.locator('[data-sequence-source="original"]').click();
    await page.locator('#sequenceRouteSelect').selectOption(JSON.stringify(['TRASH', '1']));
    await page.waitForFunction(() => document.getElementById('sequenceLayerStatus').textContent.includes('4 stops'));
    assert.match(await page.locator('#sequenceLayerStatus').innerText(), /Showing Original file · 4 stops/);
    await page.locator('#sequenceLayerToggle').uncheck();
    await page.waitForFunction(() => !map.hasLayer(sequenceLayer));
    assert.equal(await page.locator('#sequenceRouteSelect').isVisible(), true);
    await page.evaluate(() => map.fitBounds([[30.755, -98.23], [30.757, -98.228]], { padding: [50, 50], animate: false }));
    assert.deepEqual(new Set(await drawnSequenceNumbers()), new Set(['#0', '#2', '#10']));
    await page.locator('#sequenceNumbersToggle').uncheck();
    assert.deepEqual(await drawnSequenceNumbers(), []);
    assert.equal(await page.evaluate(() => map.hasLayer(sequenceNumberLabels)), false);
    await page.locator('#sequenceNumbersToggle').check();
    await page.evaluate(() => {
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[0]);
      map.removeLayer(marker);
    });
    assert.deepEqual(new Set(await drawnSequenceNumbers()), new Set(['#0', '#2']));
    await page.evaluate(() => {
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[0]);
      marker.addTo(map);
    });
    await page.locator('#sequenceRouteSelect').selectOption('all');
    await page.waitForFunction(() => map.hasLayer(sequenceLayer));
    await page.evaluate(() => closeMobileMenu());
    await page.evaluate(() => {
      const markers = Object.values(routeDayGroups).flatMap(group => group.layers);
      individuallySelectedMarkers.add(markers[0]);
      map.removeLayer(markers[1]);
      updateSelectionCount(); updateUndoButtonState();
    });
    const before = await page.evaluate(() => JSON.stringify(window._currentRows));
    const workbookBefore = await page.evaluate(() => JSON.stringify(window._currentWorkbook));
    await open();
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:/);
    assert.equal(calls[0].endpoint, 'delete_all_orders');
    assert(calls[1].body.updates.every(update => update.startLocation.latitude === 30.75));
    assert.equal(uploaded.length, 6);
    assert.equal(new Set(uploaded.map(order => order.assignedTo.externalId)).size, 2);
    assert(uploaded.every(order => order.operation === 'CREATE' && order.notificationPreference === 'dont_notify'));
    await page.locator('#saveSequenceBtn').click();
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), before);
    assert.deepEqual(await page.evaluate(() => [...optimoSequenceGroups.values()].map(group => group.stops.map(stop => stop.index))), [[2, 1, 0], [6, 5, 4]]);
    assert.equal(await page.evaluate(() => individuallySelectedMarkers.size), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem(OPTIMO_KEY_STORAGE)), 'test-key-not-real');
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentWorkbook)), workbookBefore);
    const layout = await page.evaluate(() => {
      const dialog = document.getElementById('resequenceDialog');
      return { pageOverflow: document.documentElement.scrollWidth > innerWidth, dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
        shortTargets: [...dialog.querySelectorAll('button,input:not([type=checkbox]),select')].filter(el => !el.hidden && el.getBoundingClientRect().height < 44).map(el => el.id) };
    });
    assert.deepEqual(layout, { pageOverflow: false, dialogOverflow: false, shortTargets: [] });
    await page.screenshot({ path: path.join(root, 'local-artifacts/resequence-phone.png') });
    await page.locator('#closeResequenceBtn').click();
    await page.locator('#mobileMenuBtn').click();
    await page.locator('[data-sequence-source="optimo"]').click();
    assert.match(await page.locator('#sequenceRouteSelect').innerText(), /TRASH.*3 stops/);
    assert.match(await page.locator('#sequenceRouteSelect').innerText(), /RECYCLE.*3 stops/);
    for (const [name, width, height] of [['phone', 440, 956], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.sequence-controls').scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const pickerLayout = await page.evaluate(() => {
        const panel = document.querySelector('.sequence-controls');
        return { overflow: panel.scrollWidth > panel.clientWidth || document.documentElement.scrollWidth > innerWidth,
          smallTargets: [...panel.querySelectorAll('button, select:not([hidden]), summary, input')].filter(el => el.getBoundingClientRect().height < 44).map(el => el.id) };
      });
      assert.deepEqual(pickerLayout, { overflow: false, smallTargets: [] });
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await page.screenshot({ path: path.join(root, `local-artifacts/sequence-picker-${name}-${light ? 'light' : 'dark'}.png`) });
      }
    }
    await page.setViewportSize({ width: 440, height: 956 });
    await page.evaluate(() => { document.body.classList.remove('sun-mode'); closeMobileMenu(); });
    await page.evaluate(() => { document.getElementById('sequenceSource').value = 'original'; document.getElementById('sequenceSource').dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 10);
    await page.evaluate(() => { document.getElementById('sequenceSource').value = 'optimo'; document.getElementById('sequenceSource').dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    await page.evaluate(() => { closeMobileMenu(); map.fitBounds([[30.755, -98.23], [30.757, -98.228]], { padding: [60, 60], animate: false }); });
    assert.deepEqual(new Set(await drawnSequenceNumbers()), new Set(['#1', '#3']));
    await page.screenshot({ path: path.join(root, 'local-artifacts/sequence-numbers-map.png') });
    await page.evaluate(() => Object.values(routeDayGroups)[0].layers[0].openPopup());
    assert.match(await page.locator('.leaflet-popup-content').innerText(), /Sequence: 3/);
    // Reload restores only this file's local order, including after a delivery save.
    await page.reload({ waitUntil: 'networkidle' });
    const delivered = sample.map(row => ({ ...row })); delivered[0].del_status = 'Delivered';
    await load(delivered);
    assert.equal(await page.evaluate(() => document.getElementById('sequenceSource').value), 'optimo');
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    await load(sample, 'different.xlsx');
    assert.equal(await page.evaluate(() => optimoSequenceGroups.size), 0);
    await load();
    await open();
    const trashScope = JSON.stringify(['TRASH', '1']);
    const recycleScope = JSON.stringify(['RECYCLE', '2']);
    const plannedDate = await page.locator('#optimoDate').inputValue();
    // Only this route/day's pending records are uploaded, even if map markers are hidden.
    await page.locator('#optimoScope').selectOption(trashScope);
    assert.match(await page.locator('#resequenceSummary').innerText(), /3 undelivered records selected/);
    assert.equal(await page.locator('#optimoDrivers input:visible').count(), 1);
    assert.match(await page.locator('#optimoClearDateNotice').innerText(), /delete ALL.*including other route\/day groups/);
    storedOrders.set('old-same-date', { orderNo: 'old-same-date', date: plannedDate });
    storedOrders.set('unrelated-driver-same-date', { orderNo: 'unrelated-driver-same-date', date: plannedDate });
    storedOrders.set('other-date', { orderNo: 'other-date', date: '2001-02-03' });
    calls.length = 0; mode = 'delete-hold';
    await page.locator('#generateSequenceBtn').click();
    for (let i = 0; i < 100 && !deleteHold; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(deleteHold);
    assert.deepEqual(calls.map(call => call.endpoint), ['delete_all_orders']);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    deleteHold(); mode = 'success';
    await page.waitForFunction(() => !resequenceBusy);
    assert.equal(storedOrders.has('old-same-date'), false);
    assert.equal(storedOrders.has('unrelated-driver-same-date'), false);
    assert.equal(storedOrders.has('other-date'), true);
    assert.equal(uploaded.length, 3);
    assert(uploaded.every(order => order.assignedTo.externalId === 'CART-TRASH-1'));
    assert.deepEqual(calls.find(call => call.endpoint === 'start_planning').body.useDrivers, [{ driverExternalId: 'CART-TRASH-1' }]);
    await page.locator('#saveSequenceBtn').click();
    assert.equal(await page.evaluate(key => optimoSequenceGroups.has(key), recycleScope), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[4])), null);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(phoneSequenceKey)).groups.length), 1);
    await page.reload({ waitUntil: 'networkidle' }); await load(); await open();
    assert.equal(await page.evaluate(key => optimoSequenceGroups.has(key), recycleScope), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    // No upload follows a refused, missing-success, or network-failed deletion.
    for (const failure of ['delete-failure', 'delete-unconfirmed', 'delete-network']) {
      mode = failure; calls.length = 0;
      await generate();
      assert.deepEqual(calls.map(call => call.endpoint), ['delete_all_orders']);
      assert.match(await page.locator('#resequenceStatus').innerText(), /Could not confirm.*No new records were uploaded/);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(phoneSequenceKey)).groups.length), 0);
      assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
      assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    }
    mode = 'success'; calls.length = 0;
    await page.locator('#optimoDate').fill(''); await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /valid planning date/);
    await page.locator('#optimoDate').fill(plannedDate);
    assert.deepEqual(await page.evaluate(() => ['', '2026-02-30', '2026-13-01', '2026-1-01'].map(validOptimoDate)), [false, false, false, false]);
    // Guard the API boundary too: a missing date must never reach delete_all_orders.
    await generate(); calls.length = 0;
    const guarded = await page.evaluate(async () => {
      const results = [];
      for (const body of [{}, { date: '' }, { date: '2026-02-30' }, { date: '2000-01-01' }]) {
        try { await optimoRequest(resequenceJob, 'delete_all_orders', body); results.push(false); }
        catch (error) { results.push(/valid matching planning date/.test(error.message)); }
      }
      return results;
    });
    assert.deepEqual(guarded, [true, true, true, true]); assert.equal(calls.length, 0);
    for (const failure of ['duplicate', 'partial-upload']) {
      mode = failure;
      await generate();
      assert.match(await page.locator('#resequenceStatus').innerText(), /No sequence displayed/);
      assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
      assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    }
    mode = 'order-limit'; calls.length = 0;
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /planning 6 orders.*planning order limit was exceeded/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    assert.equal(calls.filter(call => call.endpoint === 'start_planning').length, 1);
    assert.equal(calls.filter(call => call.endpoint === 'get_routes').length, 0);
    // Driver setup failures cannot upload orders or show stale sequence numbers.
    mode = 'driver-failure'; calls.length = 0;
    await generate();
    assert.deepEqual(calls.map(call => call.endpoint), ['delete_all_orders', 'update_drivers_parameters']);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Driver hours or starts could not be updated/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    // Configured-start mode must reset old date-specific GPS and widen hours too.
    mode = 'success'; calls.length = 0;
    await page.locator('#optimoStart').selectOption('depot');
    await page.evaluate(() => {
      window.realGetPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = () => { throw new Error('Configured start requested GPS'); };
    });
    await generate();
    assert.equal(calls[1].endpoint, 'update_drivers_parameters');
    assert(calls[1].body.updates.every(update => update.startLocation.type === 'employeeDefault'));
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:/);
    await page.evaluate(() => { navigator.geolocation.getCurrentPosition = window.realGetPosition; });
    await page.locator('#optimoStart').selectOption('gps');
    mode = 'success';
    await generate();
    await page.evaluate(() => { window._currentRows[0].del_status = 'Delivered'; });
    await page.locator('#saveSequenceBtn').click();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Delivery status changed/);
    // Test the existing confirm-then-mutate save with a fake delayed/rejected upload.
    await load();
    await open(); await generate(); await page.locator('#saveSequenceBtn').click();
    await page.locator('#closeResequenceBtn').click();
    await page.evaluate(() => {
      window.fakeUploads = [];
      saveProfileWorkbook = (rows, workbook) => new Promise((resolve, reject) => {
        const wb = { ...workbook, Sheets: { ...workbook.Sheets, [workbook.SheetNames[0]]: XLSX.utils.json_to_sheet(rows) } };
        window.fakeUploads.push(rows);
        window.resolveFakeUpload = result => result.error ? reject(result.error) : resolve(wb);
      });
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[0]);
      individuallySelectedMarkers.add(marker); updateSelectionCount(); updateUndoButtonState();
      document.getElementById('completeStopsBtnMobile').click();
    });
    await page.waitForFunction(() => typeof window.resolveFakeUpload === 'function');
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[0])), false);
    await page.evaluate(() => resolveFakeUpload({ error: new Error('fake failure') }));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[0])), false);
    await page.evaluate(() => { window.resolveFakeUpload = null; document.getElementById('completeStopsBtnMobile').click(); });
    await page.waitForFunction(() => typeof window.resolveFakeUpload === 'function');
    await page.evaluate(() => resolveFakeUpload({ error: null }));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[0])), false);
    assert.equal(await page.evaluate(() => window._currentRows[0].del_qty), 1);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    await page.evaluate(() => {
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[0]);
      individuallySelectedMarkers.add(marker); updateSelectionCount(); updateUndoButtonState();
      window.resolveFakeUpload = null;
      document.getElementById('completeStopsBtnMobile').click();
    });
    await page.waitForFunction(() => typeof window.resolveFakeUpload === 'function');
    await page.evaluate(() => resolveFakeUpload({ error: null }));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[0])), true);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    // A confirmed undo of an originally excluded stop must report missing coverage.
    await page.evaluate(() => {
      individuallySelectedMarkers.clear();
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[3]);
      marker.addTo(map); individuallySelectedMarkers.add(marker); updateSelectionCount(); updateUndoButtonState();
      window.resolveFakeUpload = null;
    });
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => document.getElementById('undoDeliveredBtn').click());
    await page.waitForFunction(() => typeof window.resolveFakeUpload === 'function');
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[3])), true);
    await page.evaluate(() => resolveFakeUpload({ error: null }));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[3])), false);
    assert.match(await page.evaluate(() => optimoSequenceCoverage()), /1 pending records/);
    // Large inputs must use bounded batches and retain complete per-group coverage.
    const large = Array.from({ length: 1001 }, (_, i) => ({ ...sample[0], UNIQUE: `large-${i}`, BINNO: i, SEQNO: i }));
    await load(large, 'large.xlsx'); await open();
    calls.length = 0;
    await generate();
    assert.deepEqual(calls.filter(call => call.endpoint === 'create_or_update_orders').map(call => call.body.orders.length), [500, 500, 1]);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:/);
    // More than 5,000 records must stay below a simulated 700-order planning limit.
    const thousands = Array.from({ length: 5276 }, (_, i) => ({ ...sample[0],
      UNIQUE: `section-${i}`, BINNO: i, SEQNO: i, ROUTE: i < 2701 ? 'TRASH' : 'RECYCLE', DAY: i < 2701 ? 1 : 2,
      LATITUDE: 30.71 + i * .00001, LONGITUDE: -98.23 }));
    await load(thousands, 'sections.xlsx'); await open('500'); calls.length = 0; mode = 'bounded';
    const rowsBeforeSections = await page.evaluate(() => JSON.stringify(window._currentRows));
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Partial plan:.*5,276 selected.*Earlier sections replaced/);
    const sectionPlans = calls.filter(call => call.endpoint === 'start_planning');
    assert.equal(calls.filter(call => call.endpoint === 'delete_all_orders').length, 1);
    assert.equal(sectionPlans.length, 12);
    assert(sectionPlans.every(call => call.body.useOrderObjects.length <= 500 && call.body.useDrivers.length === 1));
    const allIds = sectionPlans.flatMap(call => call.body.useOrderObjects.map(order => order.orderNo));
    assert.equal(allIds.length, 5276); assert.equal(new Set(allIds).size, 5276);
    const expectedStarts = new Map();
    for (const call of calls) {
      if (call.endpoint === 'update_drivers_parameters') for (const update of call.body.updates) {
        assert.deepEqual(update.startLocation, expectedStarts.get(update.driver.externalId) || { type: 'custom', latitude: 30.75, longitude: -98.23 });
      }
      if (call.endpoint === 'start_planning') {
        // The fake optimizer reverses the section, so its last stop is the first uploaded order.
        const last = storedOrders.get(call.body.useOrderObjects[0].orderNo);
        expectedStarts.set(last.assignedTo.externalId, { type: 'custom', latitude: last.location.latitude, longitude: last.location.longitude });
      }
    }
    await page.locator('#saveSequenceBtn').click();
    assert.deepEqual(await page.evaluate(() => [...optimoSequenceGroups.values()].map(group => group.stops.length)), [...scheduledRoutes.values()].map(orders => orders.length));
    assert(await page.evaluate(() => window._currentRows.filter(row => rowSequence(row) === null).length > 4000));
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), rowsBeforeSections);
    const savedSections = await page.evaluate(() => localStorage.getItem(phoneSequenceKey));
    assert.equal(JSON.parse(savedSections).sectionCount, 12);
    // Invalid later sections must leave no stale earlier section numbers or arrows.
    mode = 'later-duplicate'; calls.length = 0;
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /No sequence displayed/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(phoneSequenceKey)).groups.length), 0);
    assert.equal(calls.filter(call => call.endpoint === 'start_planning').length, 2);
    // Pause and resume the same planning ID without uploading the current section twice.
    await load(large, 'resume-sections.xlsx'); await open('500'); calls.length = 0; mode = 'running';
    await page.evaluate(() => {
      window.realSetTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => window.realSetTimeout(callback, delay === 2000 ? 0 : delay, ...args);
    });
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Section 1 of 3 is still running/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    const pausedId = await page.evaluate(() => resequenceJob.planningId);
    const callsBeforeKeyChange = calls.length;
    await page.locator('#optimoKey').fill('different-account-key');
    await page.locator('#resumeSequenceBtn').click();
    await page.waitForFunction(() => !resequenceBusy);
    assert.equal(calls.length, callsBeforeKeyChange);
    assert.match(await page.locator('#resequenceStatus').innerText(), /same API key/);
    await page.locator('#optimoKey').fill('test-key-not-real');
    mode = 'bounded';
    await page.locator('#resumeSequenceBtn').click();
    await page.waitForFunction(() => !resequenceBusy);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Partial plan:.*1,001 selected/);
    assert.equal(calls.filter(call => call.endpoint === 'start_planning').length, 3);
    assert.equal(calls.filter(call => call.endpoint === 'create_or_update_orders').length, 3);
    assert.equal(calls.filter(call => call.endpoint === 'delete_all_orders').length, 1);
    assert(calls.filter(call => call.endpoint === 'get_planning_status').slice(0, 61).every(call => Number(call.params.planningId) === pausedId));
    await page.evaluate(() => { window.setTimeout = window.realSetTimeout; });
    mode = 'success';
    await load(large, 'large.xlsx'); await open();
    // Stale file responses cannot attach a sequence to another workbook.
    mode = 'hold';
    await page.locator('#generateSequenceBtn').click();
    for (let i = 0; i < 100 && !hold; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(hold);
    await load(sample, 'after-switch.xlsx');
    hold(); mode = 'success';
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => optimoSequenceGroups.size), 0);
    await open(); await generate();
    // Invalid records outside the selected group must not block it; invalid selected records must.
    const invalidOtherGroup = sample.map(row => ({ ...row })); invalidOtherGroup[4].LATITUDE = '';
    await load(invalidOtherGroup, 'scope-validation.xlsx'); await open();
    await page.locator('#optimoScope').selectOption(trashScope); calls.length = 0;
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:/);
    assert.equal(uploaded.length, 3);
    assert(uploaded.every(order => order.assignedTo.externalId === 'CART-TRASH-1'));
    await page.locator('#optimoScope').selectOption(recycleScope); calls.length = 0;
    await generate(); assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /valid coordinates/);
    // Partial server plans must not borrow spreadsheet numbers or connect omitted stops.
    await load(sample, 'partial-scheduled.xlsx'); await open(); mode = 'missing';
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Partial plan: 4 scheduled \/ 6 selected.*2 unscheduled/);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    await page.locator('#saveSequenceBtn').click();
    await page.locator('#closeResequenceBtn').click();
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(row => rowSequence(row))), [null, 2, 1, null, null, 2, 1, null]);
    const partialLabels = await drawnSequenceNumbers();
    assert(partialLabels.length > 0);
    assert(partialLabels.every(text => ['#1', '#2'].includes(text)));
    const partialGeometry = await page.evaluate(() => {
      renderSequenceLayer();
      const omitted = [0, 4].map(index => L.latLng(window._currentRows[index].LATITUDE, window._currentRows[index].LONGITUDE));
      const lines = sequencePendingLine.getLatLngs();
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef === window._currentRows[0]);
      marker.openPopup();
      return { count: lines.length, touchesOmitted: lines.flat().some(point => omitted.some(missing => missing.equals(point))) };
    });
    assert.deepEqual(partialGeometry, { count: 2, touchesOmitted: false });
    assert.doesNotMatch(await page.locator('.leaflet-popup-content').innerText(), /Sequence:/);
    await page.reload({ waitUntil: 'networkidle' }); await load(sample, 'partial-scheduled.xlsx');
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), null);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[1])), 2);
    await open(); mode = 'none'; await generate(); await page.locator('#saveSequenceBtn').click();
    assert.match(await page.locator('#resequencePreviewList').innerText(), /0 scheduled \/ 3 selected/);
    assert(await page.evaluate(() => window._currentRows.every(row => rowSequence(row) === null)));
    assert.deepEqual(await drawnSequenceNumbers(), []);
    assert.equal(await page.evaluate(() => { renderSequenceLayer(); return sequencePendingLine.getLatLngs().flat(Infinity).length + sequencePendingArrows.getLatLngs().flat(Infinity).length; }), 0);
    mode = 'gaps'; await generate(); await page.locator('#saveSequenceBtn').click();
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 5);
    // Old joined snapshots cannot silently return after a refresh.
    await page.evaluate(() => localStorage.setItem(phoneSequenceKey, JSON.stringify({ version: 1, groups: [{ route: 'TRASH', day: '1', indices: [0, 1, 2] }] })));
    await page.reload({ waitUntil: 'networkidle' }); await load(sample, 'partial-scheduled.xlsx');
    assert.equal(await page.evaluate(() => document.getElementById('sequenceSource').value), 'optimo');
    assert(await page.evaluate(() => window._currentRows.every(row => rowSequence(row) === null)));
    mode = 'success';
    // Selected scope combines individual and polygon selection, excluding hidden,
    // off-screen, delivered, and explicitly deselected records.
    const selectedSample = sample.map(row => ({ ...row })); selectedSample[6].LATITUDE = 32;
    await load(selectedSample, 'selected-stops.xlsx'); await open(); await generate();
    await page.locator('#saveSequenceBtn').click();
    await page.locator('#closeResequenceBtn').click();
    await page.evaluate(() => {
      const markers = Object.values(routeDayGroups).flatMap(group => group.layers);
      const at = index => markers.find(marker => marker._rowRef === window._currentRows[index]);
      markers.forEach(marker => marker.addTo(map));
      individuallySelectedMarkers.clear(); individuallyDeselectedMarkers.clear(); drawnLayer.clearLayers();
      [0, 1, 3, 5, 6].forEach(index => individuallySelectedMarkers.add(at(index)));
      map.removeLayer(at(1));
      drawnLayer.addLayer(L.rectangle([[30.7565, -98.2285], [30.7595, -98.2255]]));
      individuallyDeselectedMarkers.add(at(4));
      map.fitBounds([[30.755, -98.23], [30.760, -98.225]], { padding: [40, 40], animate: false });
      updateSelectionCount(); updateUndoButtonState();
    });
    await open(); await page.locator('#optimoScope').selectOption('selected');
    assert.match(await page.locator('#resequenceSummary').innerText(), /3 undelivered records selected from the visible map selection/);
    assert.equal(await page.locator('#optimoDrivers input:visible').count(), 2);
    assert.match(await page.locator('#optimoDrivers label:visible').first().innerText(), /2 records/);
    await page.locator('#optimoScope').selectOption('selectedAll');
    assert.match(await page.locator('#resequenceSummary').innerText(), /4 undelivered records selected from your map selection/);
    await page.locator('#optimoScope').selectOption('selected');
    // Map picking must preserve selected stops and the viewport used by visible selection.
    const beforePick = await page.evaluate(() => ({ center: map.getCenter(), zoom: map.getZoom(), selected: [...selectedVisibleSequenceRows()].map(row => row.UNIQUE).sort() }));
    const checkRestoredView = async () => {
      const after = await page.evaluate(() => ({ center: map.getCenter(), zoom: map.getZoom(), selected: [...selectedVisibleSequenceRows()].map(row => row.UNIQUE).sort() }));
      assert.equal(after.zoom, beforePick.zoom);
      assert.deepEqual(after.selected, beforePick.selected);
      assert(Math.abs(after.center.lat - beforePick.center.lat) < .00002 && Math.abs(after.center.lng - beforePick.center.lng) < .00002);
    };
    calls.length = 0;
    await page.locator('#optimoStart').selectOption('map'); await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Choose a start location/);
    await page.evaluate(() => drawControl._toolbars.draw._modes.polygon.handler.enable());
    await page.locator('#pickOptimoStart').click();
    assert.equal(await page.locator('#resequenceDialog').isVisible(), true);
    assert.equal(await page.locator('#optimoLocationPicker').isVisible(), false);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Finish or cancel/);
    await page.evaluate(() => drawControl._toolbars.draw._modes.polygon.handler.disable());
    await page.locator('#pickOptimoStart').click();
    assert.equal(await page.locator('#resequenceDialog').isVisible(), false);
    assert.equal(await page.locator('#useOptimoLocation').isDisabled(), true);
    await page.evaluate(() => {
      map.setView([30.78, -98.2], 16, { animate: false });
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers)[0];
      marker.fire('click', { latlng: marker.getLatLng() });
    });
    await page.waitForTimeout(250);
    const expectedStart = await page.evaluate(() => map.containerPointToLatLng([190, 210]).wrap());
    await page.locator('#map').click({ position: { x: 190, y: 210 } });
    const pickedStart = await page.evaluate(() => { const p = optimoLocationPicker.marker.getLatLng().wrap(); return { type: 'custom', latitude: p.lat, longitude: p.lng }; });
    assert(Math.abs(pickedStart.latitude - expectedStart.lat) < .000001 && Math.abs(pickedStart.longitude - expectedStart.lng) < .000001);
    assert.equal(await page.locator('#useOptimoLocation').isDisabled(), false);
    assert.equal(await page.evaluate(() => getComputedStyle(sequenceNumberPane).visibility), 'hidden');
    assert.equal(await page.evaluate(() => getComputedStyle(sequencePane).visibility), 'hidden');
    for (const light of [false, true]) {
      await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
      const layout = await page.evaluate(() => {
        const panel = document.getElementById('optimoLocationPicker'), button = document.getElementById('useOptimoLocation'), style = getComputedStyle(button);
        return { overflow: panel.scrollWidth > panel.clientWidth, overlapsMap: panel.getBoundingClientRect().top < map.getContainer().getBoundingClientRect().bottom - 1,
          small: [...panel.querySelectorAll('button')].some(el => el.getBoundingClientRect().height < 44), unreadable: style.color === style.backgroundColor };
      });
      assert.deepEqual(layout, { overflow: false, overlapsMap: false, small: false, unreadable: false });
      await page.screenshot({ path: path.join(root, `local-artifacts/optimo-map-picker-phone-${light ? 'light' : 'dark'}.png`) });
    }
    await page.locator('#useOptimoLocation').click();
    await checkRestoredView();
    assert.equal(await page.locator('#optimoStart').inputValue(), 'map');
    await page.locator('#optimoEnd').selectOption('map'); await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Choose an end location/);
    await page.locator('#pickOptimoEnd').click();
    await page.evaluate(() => map.setView([30.79, -98.19], 17, { animate: false }));
    await page.locator('#centerOptimoLocation').click();
    const pin = page.locator('.optimo-location-icon.leaflet-marker-draggable');
    const box = await pin.boundingBox();
    const expectedEnd = await page.evaluate(() => map.containerPointToLatLng(map.latLngToContainerPoint(optimoLocationPicker.marker.getLatLng()).add([35, 20])).wrap());
    await page.mouse.move(box.x + 32, box.y + 22); await page.mouse.down();
    await page.mouse.move(box.x + 67, box.y + 42, { steps: 8 }); await page.mouse.up();
    const pickedEnd = await page.evaluate(() => { const point = optimoLocationPicker.marker.getLatLng().wrap(); return { type: 'custom', latitude: point.lat, longitude: point.lng }; });
    assert(Math.abs(pickedEnd.latitude - expectedEnd.lat) < .00001 && Math.abs(pickedEnd.longitude - expectedEnd.lng) < .00001);
    await page.evaluate(() => map.panBy([40, 30], { animate: false }));
    assert.deepEqual(await page.evaluate(() => { const p = optimoLocationPicker.marker.getLatLng().wrap(); return { type: 'custom', latitude: p.lat, longitude: p.lng }; }), pickedEnd);
    await page.locator('#useOptimoLocation').click();
    await checkRestoredView();
    assert.equal(await page.evaluate(() => getComputedStyle(sequenceNumberPane).visibility), 'visible');
    // Cancel preserves the previous endpoint without API requests.
    const endBeforeCancel = await page.evaluate(() => ({ ...optimoMapLocations.end }));
    await page.locator('#pickOptimoEnd').click();
    await page.evaluate(() => map.setView([31, -98], 15, { animate: false }));
    await page.locator('#centerOptimoLocation').click();
    await page.locator('#cancelOptimoLocation').click();
    assert.deepEqual(await page.evaluate(() => optimoMapLocations.end), endBeforeCancel);
    assert.equal(calls.length, 0);
    calls.length = 0;
    await generate();
    assert.deepEqual(uploaded.map(order => Number(order.orderNo.split('-').pop())), [0, 2, 5]);
    assert.equal(calls.filter(call => call.endpoint === 'delete_all_orders').length, 1);
    const endpointUpdate = calls.find(call => call.endpoint === 'update_drivers_parameters');
    for (const update of endpointUpdate.body.updates) {
      assert.deepEqual(update.startLocation, pickedStart);
      assert.deepEqual(update.endLocation, pickedEnd);
    }
    await page.locator('#saveSequenceBtn').click();
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(row => rowSequence(row))), [2, null, 1, null, null, 1, null, null]);
    assert.deepEqual(await page.evaluate(() => [...optimoSequenceGroups.values()].flatMap(group => group.stops.map(stop => stop.index)).sort()), [0, 2, 5]);
    for (const [name, width, height] of [['phone', 440, 956], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#optimoScope').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.getElementById('resequenceDialog').scrollWidth > document.getElementById('resequenceDialog').clientWidth), false);
      await page.screenshot({ path: path.join(root, `local-artifacts/selected-planning-${name}.png`) });
      if (name === 'desktop') {
        await page.locator('#pickOptimoEnd').click();
        const pickerLayout = await page.evaluate(() => {
          const panel = document.getElementById('optimoLocationPicker');
          return { overflow: panel.scrollWidth > panel.clientWidth, small: [...panel.querySelectorAll('button')].some(button => button.getBoundingClientRect().height < 44) };
        });
        assert.deepEqual(pickerLayout, { overflow: false, small: false });
        await page.screenshot({ path: path.join(root, 'local-artifacts/optimo-map-picker-desktop.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#resequenceDialog').isVisible(), true);
        assert.deepEqual(await page.evaluate(() => optimoMapLocations.end), endBeforeCancel);
      }
    }
    await page.setViewportSize({ width: 440, height: 956 });
    await page.locator('#optimoStart').selectOption('depot');
    await page.locator('#optimoEnd').selectOption('start'); calls.length = 0;
    await generate();
    assert(calls.find(call => call.endpoint === 'update_drivers_parameters').body.updates.every(update => update.startLocation.type === 'employeeDefault' && update.endLocation.type === 'startLocation'));
    await page.locator('#saveSequenceBtn').click();
    // Selected stops includes selected off-screen records, with no unselected additions.
    await page.locator('#optimoScope').selectOption('selectedAll'); calls.length = 0;
    await generate();
    assert.deepEqual(uploaded.map(order => Number(order.orderNo.split('-').pop())), [0, 2, 5, 6]);
    await page.locator('#optimoScope').selectOption('selected');
    await generate(); await page.locator('#saveSequenceBtn').click();
    await page.reload({ waitUntil: 'networkidle' }); await load(selectedSample, 'selected-stops.xlsx');
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(row => rowSequence(row))), [2, null, 1, null, null, 1, null, null]);
    await open(); await page.locator('#optimoScope').selectOption('selected'); calls.length = 0;
    await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /No selected, visible undelivered stops/);
    // All-groups behavior still works without a map selection.
    await page.locator('#optimoScope').selectOption('');
    await generate(); assert.equal(uploaded.length, 6);
    const onlyDelivered = sample.map(row => ({ ...row, del_status: 'Delivered' }));
    await load(onlyDelivered, 'all-delivered.xlsx'); await open(); calls.length = 0;
    assert.equal(await page.locator('#optimoScope option').count(), 3);
    await generate(); assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /No undelivered records/);
    // Invalid rows and refused GPS stop before any external API mutation.
    const invalid = sample.map(row => ({ ...row })); invalid[0].LATITUDE = '';
    await load(invalid, 'invalid.xlsx'); await open(); calls.length = 0;
    await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /valid coordinates/);
    await load(sample, 'gps-test.xlsx'); await open();
    await page.evaluate(() => {
      window.realGetPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = (success, failure) => failure({ code: 1 });
    });
    await generate();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Could not get your location/);
    await page.evaluate(() => { navigator.geolocation.getCurrentPosition = window.realGetPosition; });
    await generate();
    await page.evaluate(() => {
      document.body.classList.add('sun-mode');
      document.getElementById('resequenceDialog').style.maxHeight = 'calc(100dvh - 59px - 34px - 24px)';
      document.getElementById('resequenceDialog').scrollTop = 0;
    });
    assert.equal(await page.evaluate(() => document.getElementById('resequenceDialog').getBoundingClientRect().height <= innerHeight - 93), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, 'local-artifacts/resequence-phone-light.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.body.classList.remove('sun-mode'); document.getElementById('resequenceDialog').style.maxHeight = ''; });
    await page.screenshot({ path: path.join(root, 'local-artifacts/resequence-desktop-dark.png') });
    await page.evaluate(() => document.body.classList.add('sun-mode'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(root, 'local-artifacts/resequence-desktop.png') });
    await page.locator('#forgetOptimoKey').click();
    assert.equal(await page.evaluate(() => localStorage.getItem(OPTIMO_KEY_STORAGE)), null);
    assert.deepEqual(errors, []);
    console.log('PASS: phone/desktop layouts; scheduled-only partial and empty plans; no omitted-stop numbers or arrows; server stop numbers; stale joined snapshot migration; date cleanup invalidates old groups; bounded 5,276-record planning with final server snapshot; resume; account limits; local persistence; confirm-then-mutate fake saves.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
