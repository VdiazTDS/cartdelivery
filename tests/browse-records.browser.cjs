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
    for (const width of [440, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 956 }, hasTouch: width === 440, serviceWorkers: 'block' });
      const writes = [], errors = [];
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.endsWith('/style.css') && width === 440) return route.fulfill({ contentType: 'text/css',
          body: fs.readFileSync(path.join(root, 'style.css'), 'utf8').replaceAll('env(safe-area-inset-top)', '59px').replaceAll('env(safe-area-inset-bottom)', '34px') });
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.includes('/functions/')) {
            const action = request.postDataJSON().action;
            if (!['public-list', 'list', 'work-areas'].includes(action)) writes.push(action);
          } else if (request.method() !== 'GET' && !url.pathname.includes('/object/list/')) writes.push(url.pathname);
          return route.fulfill({ contentType: 'application/json', body: '[]' });
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        window.loadBrowseFixture = () => {
          const rows = Array.from({ length: 55 }, (_, i) => ({ LATITUDE: 30.75, LONGITUDE: -98.23,
            ROUTE: 'A', DAY: 1, NEWROUTE: 'Wrong', NEWDAY: 7, QTY: 2, BINNO: `BIN-${i + 1}`,
            'CSADR#': 100, CSSTRT: 'Oak', 'Unique field': `Customer ${i + 1}` }));
          rows.push({ ...rows[0], LATITUDE: 31.75, BINNO: 'OFFSCREEN' });
          rows.push({ ...rows[0], BINNO: 'HIDDEN', del_status: 'Delivered' });
          const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
          profileState.workspace = { mode: 'original', legacy: true, name: 'Sample.xlsx' };
          window._currentFilePath = 'Sample.xlsx'; processExcelBuffer(null, wb, rows); renderProfileState();
          map.setView([30.75, -98.23], 18, { animate: false });
          const first = Object.values(routeDayGroups).flatMap(g => g.layers)[0];
          toggleIndividualStopSelection(first); updateSelectionCount(); updateUndoButtonState();
        };
        loadBrowseFixture();
      });
      const before = await page.evaluate(() => JSON.stringify(_currentRows));
      const browse = page.locator('#browseMapRecordsBtn');
      const card = width === 440 ? '#mobileStopDetails' : '.leaflet-popup';
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        if (width === 440) await page.locator('#mobileSelectionBtn').click();
        await browse.click();
        assert.match(await page.locator('#mobileStopPickerMessage').textContent(), /^55 records/);
        assert.equal(await page.locator('.mobile-stop-choice-bin').count(), 50);
        assert.match(await page.locator('.mobile-stop-choice-detail').first().textContent(), /Route A.*Monday/);
        assert.equal(await page.locator('#mobileStopPickerList').getByText('Bin #: OFFSCREEN', { exact: true }).count(), 0);
        assert.equal(await page.locator('#mobileStopPickerList').getByText('Bin #: HIDDEN', { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => mobileStopSelectionMode), false);
        assert.equal(await page.locator('#selectionCount').textContent(), '1');
        const box = await browse.boundingBox();
        assert(box.height >= 44 && box.y >= 0 && box.y + box.height <= 956);
        assert(['rgb(255, 20, 147)', 'rgb(255, 78, 174)'].includes(await browse.evaluate(el => getComputedStyle(el).backgroundColor)));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(root, `local-artifacts/browse-records-${width}-${light ? 'light' : 'dark'}.png`) });
        await page.getByRole('button', { name: 'Show more records', exact: false }).click();
        assert.equal(await page.locator('.mobile-stop-choice-bin').count(), 55);
        await page.locator('.mobile-stop-choice').filter({ has: page.getByText('Bin #: BIN-55', { exact: true }) }).click();
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, `${card} .record-fields-button`);
        assert.match(await page.locator(`${card} .delivery-stop-bin`).textContent(), /BIN-55/);
        await page.locator(`${card} .record-fields-button`).click();
        await page.waitForFunction(() => document.querySelector('#recordFieldsList').textContent.includes('Customer 55'));
        assert.match(await page.locator('#recordFieldsIdentity').textContent(), /BIN-55/);
        await page.locator('#closeRecordFieldsBtn').click();
        await page.locator(`${card} .choose-overlapping-stop`).click();
        assert.match(await page.locator('#mobileStopPickerMessage').textContent(), /^55 records/);
        await page.locator('.mobile-stop-choice').filter({ has: page.getByText('Bin #: BIN-2', { exact: true }) }).click();
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, `${card} .record-fields-button`);
        await page.locator(`${card} .record-fields-button`).click();
        await page.waitForFunction(() => document.querySelector('#recordFieldsList').textContent.includes('Customer 2'));
        assert.match(await page.locator('#recordFieldsIdentity').textContent(), /BIN-2/);
        await page.locator('#closeRecordFieldsBtn').click();
        assert.equal(await page.evaluate(() => JSON.stringify(_currentRows)), before);
        assert.equal(await page.locator('#selectionCount').textContent(), '1');
      }
      await browse.click();
      await page.evaluate(() => applyFilters());
      assert.equal(await page.locator('#mobileStopPicker').isVisible(), false);
      assert.equal(await page.evaluate(() => mapBrowseStops.length), 0);
      await page.evaluate(() => map.setView([35, -100], 18, { animate: false }));
      await browse.click();
      assert.match(await page.locator('#mobileStopPickerMessage').textContent(), /No records/);
      assert.equal(await page.locator('#mobileStopPickerClose').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mobileStopPicker').isVisible(), false);
      await page.evaluate(() => loadBrowseFixture());
      await page.setViewportSize({ width: width === 440 ? 1440 : 440, height: 956 });
      await browse.click();
      assert.match(await page.locator('#mobileStopPickerMessage').textContent(), /^55 records/);
      assert.equal(await browse.evaluate(el => el.parentElement.id), width === 440 ? 'desktopLocateContainer' : 'deliveryControls');
      await page.evaluate(() => document.getElementById('resetMapBtn').click());
      assert.equal(await page.evaluate(() => mapBrowseStops.length), 0);
      assert.equal(await page.locator('#mobileStopPicker').isVisible(), false);
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      await context.close();
      console.log(`PASS ${width}: coincident records, exact source fields, pagination, filters, viewport, selections, empty state, reset, resize, themes, safe areas, no writes.`);
    }
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
