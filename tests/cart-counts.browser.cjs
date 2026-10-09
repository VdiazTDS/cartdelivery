const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

const sample = [1, 2, '3', 0, '', 'bad', -1, 1.5, 3, 5, 2, 3].map((qty, i) => ({
  ID: i, ROUTE: i === 10 ? 'B' : 'A', DAY: i === 10 ? 2 : 1, NEWROUTE: 'IGNORED', NEWDAY: 7,
  SEQNO: i + 1, QTY: qty, BINNO: `00${i}`, 'CSADR#': i === 11 ? 102 : 100 + i,
  CSSTRT: 'TEST', LATITUDE: 30.75 + i * .0005, LONGITUDE: -98.23,
  del_status: i === 8 ? 'Delivered' : '', ...(i === 9 ? { del_qty: 2 } : {})
}));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, hasTouch: true, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host.endsWith('supabase.co') || host === 'api.optimoroute.com') return route.fulfill({ contentType: 'application/json', body: '[]' });
      if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(host)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      window.uploads = [];
      sb.storage.from = () => ({ upload: (file, bytes) => new Promise(resolve => {
        const wb = XLSX.read(bytes, { type: 'array' });
        window.uploads.push({ file, rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]), sheets: wb.SheetNames });
        window.resolveUpload = resolve;
      }) });
      window.testMarkers = () => Object.values(routeDayGroups).flatMap(group => group.layers);
    });
    const load = (rows = sample, file = 'cart-counts.xlsx') => page.evaluate(({ rows, file }) => {
      layerVisibilityState = {};
      document.getElementById('multipleCartsOnly').checked = false;
      window._currentFilePath = file;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ note: 'Preserve me' }]), 'Notes');
      processExcelBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    }, { rows, file });
    const select = ids => page.evaluate(ids => {
      drawnLayer.clearLayers();
      individuallySelectedMarkers.clear(); individuallyDeselectedMarkers.clear();
      testMarkers().filter(marker => ids.includes(marker._rowRef.ID)).forEach(marker => individuallySelectedMarkers.add(marker));
      updateSelectionCount(); updateUndoButtonState();
    }, ids);
    const state = () => page.evaluate(() => ({
      rows: JSON.stringify(window._currentRows),
      stops: testMarkers().map(marker => ({ id: marker._rowRef.ID, visible: map.hasLayer(marker), badge: marker._quantityLabel?.textContent, done: isDeliveredRow(marker._rowRef) })).sort((a, b) => a.id - b.id),
      selected: document.getElementById('selectionCount').textContent
    }));
    const visible = () => page.evaluate(() => testMarkers().filter(marker => map.hasLayer(marker)).map(marker => marker._rowRef.ID).sort((a, b) => a - b));
    const toggle = (id, checked) => page.evaluate(({ id, checked }) => {
      const input = document.getElementById(id); input.checked = checked; input.dispatchEvent(new Event('change'));
    }, { id, checked });
    const layer = (key, checked) => page.evaluate(({ key, checked }) => {
      const input = [...document.querySelectorAll('input[data-key]')].find(el => el.dataset.key === key);
      input.checked = checked; input.dispatchEvent(new Event('change'));
    }, { key, checked });
    const begin = async (ids, operation = 'add', amount = '1') => {
      await select(ids);
      await page.locator('#recordCartsBtn').click();
      await page.locator('#cartCountOperation').selectOption(operation);
      await page.locator('#cartCountAmount').fill(amount);
    };
    const submit = async () => {
      await page.evaluate(() => { window.resolveUpload = null; });
      await page.locator('#saveCartCountsBtn').click();
      await page.waitForFunction(() => typeof window.resolveUpload === 'function');
    };
    const resolve = async (fail = false) => {
      await page.evaluate(fail => resolveUpload({ error: fail ? new Error('Simulated failure') : null }), fail);
      await page.waitForFunction(() => !deliverySaveInProgress);
    };

    await load();
    assert.deepEqual(await page.evaluate(() => window._currentRows.slice(8, 10).map(deliveredCartCount)), [3, 2]);
    await select([0, 1, 2]);
    await toggle('multipleCartsOnly', true);
    assert.deepEqual(await visible(), [1, 2, 9, 10, 11]);
    assert.equal((await state()).selected, '2');
    await layer('A|1', false);
    assert.deepEqual(await visible(), [10]);
    await toggle('multipleCartsOnly', false);
    assert.deepEqual(await visible(), [10]);
    await layer('A|1', true);
    await toggle('multipleCartsOnly', true);
    await layer('A|Delivered', true);
    assert.deepEqual(await visible(), [8, 10]);
    await layer('A|1', true);

    // Route/day filters remain in force when changing the quantity filter.
    await page.evaluate(() => {
      const day = document.querySelector('#dayCheckboxes input[value="2"]');
      day.checked = false; day.dispatchEvent(new Event('change'));
    });
    await toggle('multipleCartsOnly', false);
    assert(!(await visible()).includes(10));
    await toggle('multipleCartsOnly', true);
    assert(!(await visible()).includes(10));
    await page.evaluate(() => {
      const day = document.querySelector('#dayCheckboxes input[value="2"]');
      day.checked = true; day.dispatchEvent(new Event('change'));
      individuallySelectedMarkers.clear(); individuallyDeselectedMarkers.clear();
      const shape = L.rectangle([[30.7499, -98.2301], [30.7511, -98.2299]]);
      drawnLayer.addLayer(shape);
      const excluded = testMarkers().find(marker => marker._rowRef.ID === 2);
      individuallyDeselectedMarkers.add(excluded);
      updateSelectionCount(); updateUndoButtonState();
    });
    await page.locator('#recordCartsBtn').click();
    assert.match(await page.locator('#cartCountSummary').textContent(), /^1 selected stop/);
    assert.match(await page.locator('#cartCountPreview').textContent(), /Bin 001/);
    await page.locator('#closeCartCountsBtn').click();

    // First pass, including one-cart stops. No local state changes until upload confirmation.
    await toggle('multipleCartsOnly', false);
    await begin([0, 1, 2]);
    const before = await state();
    const fingerprint = await page.evaluate(() => phoneSequenceStorageKey(window._currentRows));
    await page.evaluate(() => { window.oldWorkbook = window._currentWorkbook; });
    await submit();
    assert.deepEqual(await state(), before);
    assert.equal(await page.evaluate(() => window._currentWorkbook === window.oldWorkbook), true);
    assert.equal(await page.locator('#recordCartsBtn').isDisabled(), true);
    const upload = await page.evaluate(() => window.uploads.at(-1));
    assert.deepEqual(upload.rows.slice(0, 3).map(row => row.del_qty), [1, 1, 1]);
    assert.deepEqual(upload.sheets, ['Stops', 'Notes']);
    await resolve(true);
    assert.deepEqual(await state(), before);
    assert.match(await page.locator('#cartCountStatus').textContent(), /Not saved/);
    await submit(); await resolve();
    await page.waitForFunction(() => !document.getElementById('cartCountsDialog').open);
    assert.deepEqual(await page.evaluate(() => window._currentRows.slice(0, 3).map(row => [row.del_qty, isDeliveredRow(row)])), [[1, true], [1, false], [1, false]]);
    assert.equal(await page.evaluate(() => phoneSequenceStorageKey(window._currentRows)), fingerprint);
    assert.equal((await state()).stops[1].badge, '1/2');
    assert.equal((await state()).stops[2].badge, '1/3');
    assert(!((await visible()).includes(0)));
    await toggle('multipleCartsOnly', true);
    await begin([1, 2]); await submit(); await resolve();
    assert.deepEqual(await page.evaluate(() => window._currentRows.slice(1, 3).map(row => [row.del_qty, isDeliveredRow(row)])), [[2, true], [2, false]]);
    assert(!(await visible()).includes(1));
    assert((await visible()).includes(2));

    // Reload the uploaded workbook and read persisted progress.
    await load(await page.evaluate(() => window.uploads.at(-1).rows));
    assert.equal((await state()).stops[2].badge, '2/3');
    await begin([2], 'add', '2');
    assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
    assert.match(await page.locator('#cartCountStatus').textContent(), /exceed QTY/);
    await page.locator('#cartCountAmount').fill('0.5');
    assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
    await page.locator('#closeCartCountsBtn').click();
    await begin([4]);
    assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
    await page.locator('#closeCartCountsBtn').click();

    // Correct a legacy Delivered stop to one cart, then reset a partial count to zero.
    await layer('A|Delivered', true);
    await begin([8], 'set', '1'); await submit(); await resolve();
    assert.equal(await page.evaluate(() => isDeliveredRow(window._currentRows[8])), false);
    await layer('A|1', true);
    await begin([8], 'set', '0'); await submit(); await resolve();
    assert.equal(await page.evaluate(() => deliveredCartCount(window._currentRows[8])), 0);
    await select([8]); await select([]);
    assert.notEqual(await page.evaluate(() => testMarkers().find(marker => marker._rowRef.ID === 8).options.color), '#00FF00');
    // Existing complete/undo controls must maintain both count and status.
    await select([2]);
    await page.evaluate(() => { window.resolveUpload = null; document.getElementById('completeStopsBtnMobile').click(); });
    await page.waitForFunction(() => typeof window.resolveUpload === 'function'); await resolve();
    assert.equal(await page.evaluate(() => window._currentRows[2].del_qty), 3);
    await layer('A|Delivered', true); await select([2]);
    await page.evaluate(() => { window.resolveUpload = null; document.getElementById('undoDeliveredBtn').click(); });
    await page.waitForFunction(() => typeof window.resolveUpload === 'function'); await resolve();
    assert.equal(await page.evaluate(() => window._currentRows[2].del_qty), 0);
    await layer('A|1', true);

    // Search totals subtract partial deliveries and separate colocated customer/bin rows.
    await page.evaluate(() => {
      document.querySelector('[data-search-status="all"]').click();
    });
    assert.match(await page.locator('#searchCartTotals').textContent(), /15.5 known carts remaining/);
    assert.match(await page.locator('#searchResultsList').textContent(), /2 of 5 carts delivered/);
    await begin([9]);
    const duplicateBefore = await page.evaluate(() => JSON.stringify(window._currentRows[11]));
    await submit(); await resolve();
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows[11])), duplicateBefore);

    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await page.evaluate(value => document.body.classList.toggle('sun-mode', value), light);
        await begin([2, 9]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const bounds = await page.locator('#saveCartCountsBtn').boundingBox();
        assert(bounds.height >= 44);
        await page.screenshot({ path: path.join(root, `local-artifacts/cart-counts-${width}-${light}.png`) });
        await page.locator('#closeCartCountsBtn').click();
      }
    }
    // A file opened mid-upload must retain its own rows and workbook.
    await begin([2]); await submit();
    await load([{ ...sample[0], ID: 99, QTY: 4 }], 'different.xlsx');
    const other = await state(); await resolve();
    assert.deepEqual(await state(), other);

    // Main delivery action defaults to one cart per record when the filter is off.
    const passRows = [sample[0], sample[1], sample[2], sample[11]];
    await load(passRows);
    await select([0, 1, 2, 11]);
    assert.equal(await page.locator('#completeStopsBtn').textContent(), 'Deliver 1 cart per stop');
    const beforeFirstPass = await state();
    const clickDeliver = async () => {
      const width = page.viewportSize().width;
      await page.evaluate(() => { window.resolveUpload = null; });
      await page.locator(width <= 900 ? '#completeStopsBtnMobile' : '#completeStopsBtn').click();
    };
    await clickDeliver();
    await page.waitForFunction(() => typeof window.resolveUpload === 'function');
    assert.deepEqual(await state(), beforeFirstPass);
    await resolve(true);
    assert.deepEqual(await state(), beforeFirstPass);
    await clickDeliver();
    await page.waitForFunction(() => typeof window.resolveUpload === 'function'); await resolve();
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(row => [row.del_qty, isDeliveredRow(row)])), [[1, true], [1, false], [1, false], [1, false]]);
    assert.deepEqual(await visible(), [1, 2, 11]);
    await toggle('multipleCartsOnly', true);
    const savedFirstPass = await page.evaluate(() => JSON.stringify(window._currentRows));
    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await page.evaluate(value => document.body.classList.toggle('sun-mode', value), light);
        await select([0, 1, 2, 11]);
        const uploadsBefore = await page.evaluate(() => window.uploads.length);
        await clickDeliver();
        assert.equal(await page.locator('#cartCountOperation').inputValue(), 'each');
        const fields = page.locator('#cartCountEntries input');
        assert.equal(await fields.count(), 3);
        assert.equal(await fields.nth(0).inputValue(), '');
        assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
        await fields.nth(0).fill('2');
        await fields.nth(1).fill('2');
        await fields.nth(2).fill('0');
        assert.match(await page.locator('#cartCountStatus').textContent(), /exceed QTY/);
        await fields.nth(0).fill('0.5');
        assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
        await fields.nth(0).fill('-1');
        assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
        await fields.nth(0).fill('1');
        assert.equal(await page.locator('#saveCartCountsBtn').isEnabled(), true);
        assert.match(await page.locator('#cartCountEntries').textContent(), /After saving: 2 of 2 delivered/);
        assert.match(await page.locator('#cartCountEntries').textContent(), /After saving: 3 of 3 delivered/);
        assert.match(await page.locator('#cartCountEntries').textContent(), /After saving: 1 of 3 delivered/);
        assert.equal(await page.evaluate(() => window.uploads.length), uploadsBefore);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const bounds = await fields.first().boundingBox();
        assert(bounds.height >= 44);
        await page.screenshot({ path: path.join(root, `local-artifacts/cart-delivery-prompt-${width}-${light}.png`) });
        await page.locator('#closeCartCountsBtn').click();
        assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), savedFirstPass);
      }
    }
    await select([1, 2, 11]); await clickDeliver();
    const fields = page.locator('#cartCountEntries input');
    for (let i = 0; i < 3; i++) await fields.nth(i).fill('0');
    assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
    await fields.nth(0).fill('1'); await fields.nth(1).fill('2');
    await submit();
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), savedFirstPass);
    await resolve(true);
    assert.equal(await page.evaluate(() => JSON.stringify(window._currentRows)), savedFirstPass);
    assert.equal(await fields.nth(1).inputValue(), '2');
    await submit(); await resolve();
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(row => [row.del_qty, isDeliveredRow(row)])), [[1, true], [2, true], [3, true], [1, false]]);
    assert.deepEqual(await visible(), [11]);
    await load(await page.evaluate(() => window.uploads.at(-1).rows));
    assert.deepEqual(await page.evaluate(() => window._currentRows.map(deliveredCartCount)), [1, 2, 3, 1]);
    // Every record gets an input, including those beyond the bulk preview's 50-row limit.
    await load(Array.from({ length: 51 }, (_, i) => ({ ...sample[2], ID: i, BINNO: String(i) })));
    await toggle('multipleCartsOnly', true); await select(Array.from({ length: 51 }, (_, i) => i)); await clickDeliver();
    assert.equal(await page.locator('#cartCountEntries input').count(), 51);
    await page.locator('#cartCountEntries input').last().fill('1');
    assert.equal(await page.locator('#saveCartCountsBtn').isDisabled(), true);
    await page.locator('#closeCartCountsBtn').click();
    assert.deepEqual(errors, []);
    console.log('PASS: QTY map filter, legacy/partial counts, per-stop previews, delayed/failed/successful saves, persisted workbook, finish/undo, sequence fingerprint, file-switch guard, and both layouts/themes.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

