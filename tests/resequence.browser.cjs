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
          else for (const [id, order] of storedOrders) if (order.date === body.date) storedOrders.delete(id);
        } else if (endpoint === 'update_drivers_parameters') {
          uploaded = [];
          result.updates = body.updates.map((update, i) => ({ success: !(mode === 'driver-failure' && i === 0), driver: update.driver, date: update.date }));
          for (const update of body.updates) {
            assert.equal(update.enabled, true);
            assert.deepEqual(update.workTime, { from: '00:00', to: '23:59' });
            if (update.startLocation.type === 'custom') assert(Number.isFinite(update.startLocation.latitude));
            else assert.deepEqual(update.startLocation, { type: 'employeeDefault' });
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
        } else if (endpoint === 'get_planning_status') result.status = mode === 'running' ? 'R' : 'F';
        else if (endpoint === 'get_routes') {
          const driver = url.searchParams.get('driverExternalId');
          let stops = planned.filter(order => order.assignedTo.externalId === driver).reverse().map((order, i) => ({ orderNo: order.orderNo, stopNumber: i + 1 }));
          if (mode === 'missing' || (mode === 'later-missing' && calls.filter(call => call.endpoint === 'start_planning').length === 2)) stops.pop();
          if (mode === 'duplicate' && stops.length > 1) stops[1] = { ...stops[0] };
          result.routes = [{ driverExternalId: driver, stops: stops.reverse() }];
        } else throw new Error(`Unexpected Optimo request: ${endpoint}`);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
      }
      if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof processExcelBuffer === 'function');
    const load = async (rows = sample, name = 'test.xlsx') => {
      await page.evaluate(({ rows, name }) => {
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
    await load();
    assert.equal(await page.locator('#optimoSectionSize').inputValue(), '500');
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
    await page.evaluate(() => { document.getElementById('sequenceSource').value = 'original'; document.getElementById('sequenceSource').dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 10);
    await page.evaluate(() => { document.getElementById('sequenceSource').value = 'optimo'; document.getElementById('sequenceSource').dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
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
    const recycleBefore = await page.evaluate(key => JSON.stringify(optimoSequenceGroups.get(key).stops.map(stop => stop.index)), recycleScope);
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
    assert.equal(await page.evaluate(key => JSON.stringify(optimoSequenceGroups.get(key).stops.map(stop => stop.index)), recycleScope), recycleBefore);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(phoneSequenceKey)).groups.length), 2);
    await page.reload({ waitUntil: 'networkidle' }); await load(); await open();
    assert.equal(await page.evaluate(key => JSON.stringify(optimoSequenceGroups.get(key).stops.map(stop => stop.index)), recycleScope), recycleBefore);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    // No upload follows a refused, missing-success, or network-failed deletion.
    for (const failure of ['delete-failure', 'delete-unconfirmed', 'delete-network']) {
      mode = failure; calls.length = 0;
      const saved = await page.evaluate(() => localStorage.getItem(phoneSequenceKey));
      await generate();
      assert.deepEqual(calls.map(call => call.endpoint), ['delete_all_orders']);
      assert.match(await page.locator('#resequenceStatus').innerText(), /Could not confirm.*No new records were uploaded/);
      assert.equal(await page.evaluate(() => localStorage.getItem(phoneSequenceKey)), saved);
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
    for (const failure of ['missing', 'duplicate', 'partial-upload']) {
      mode = failure;
      await generate();
      assert.match(await page.locator('#resequenceStatus').innerText(), /Previous sequence kept/);
      assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
      assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    }
    mode = 'order-limit'; calls.length = 0;
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /planning 6 orders.*planning order limit was exceeded/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
    assert.equal(calls.filter(call => call.endpoint === 'start_planning').length, 1);
    assert.equal(calls.filter(call => call.endpoint === 'get_routes').length, 0);
    // Driver setup failures cannot upload orders or replace the saved sequence.
    mode = 'driver-failure'; calls.length = 0;
    await generate();
    assert.deepEqual(calls.map(call => call.endpoint), ['delete_all_orders', 'update_drivers_parameters']);
    assert.match(await page.locator('#resequenceStatus').innerText(), /Driver hours or starts could not be updated/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => rowSequence(window._currentRows[0])), 3);
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
    await page.evaluate(() => {
      window.fakeUploads = [];
      sb.storage.from = () => ({ upload: (...args) => new Promise(resolve => { window.fakeUploads.push(args); window.resolveFakeUpload = resolve; }) });
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
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:.*Joined 12 OptimoRoute sections/);
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
    assert.deepEqual(await page.evaluate(() => [...optimoSequenceGroups.values()].map(group => group.stops.length)), [2701, 2575]);
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), rowsBeforeSections);
    const savedSections = await page.evaluate(() => localStorage.getItem(phoneSequenceKey));
    assert.equal(JSON.parse(savedSections).sectionCount, 12);
    // Failure in a later section must retain the complete saved result, including its storage.
    mode = 'later-missing'; calls.length = 0;
    await generate();
    assert.match(await page.locator('#resequenceStatus').innerText(), /Previous sequence kept/);
    assert.equal(await page.locator('#saveSequenceBtn').isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem(phoneSequenceKey)), savedSections);
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
    assert.match(await page.locator('#resequenceStatus').innerText(), /Complete:.*Joined 3/);
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
    const onlyDelivered = sample.map(row => ({ ...row, del_status: 'Delivered' }));
    await load(onlyDelivered, 'all-delivered.xlsx'); await open(); calls.length = 0;
    assert.equal(await page.locator('#optimoScope option').count(), 1);
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
    console.log('PASS: phone/desktop layouts; scoped undelivered records and merged saved groups; date-only cleanup before upload; refused/unconfirmed/network-failed cleanup; invalid dates; one cleanup across 12 planning sections and resume; account consistency; 5,276-record coverage; all-day starts; incomplete results; local persistence; confirm-then-mutate fake delivery saves; stale responses.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
