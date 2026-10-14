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
      let bytes, downloads = 0, failSource = false, failWorker = false, holdSource = false, releaseSource;
      const actions = [], errors = [], writes = [];
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.endsWith('/record-fields-worker.js') && failWorker) return route.fulfill({ contentType: 'application/javascript', body: 'throw new Error("Fixture worker failure");' });
        if (url.pathname.endsWith('/style.css') && width === 440) return route.fulfill({ contentType: 'text/css',
          body: fs.readFileSync(path.join(root, 'style.css'), 'utf8').replaceAll('env(safe-area-inset-top)', '59px').replaceAll('env(safe-area-inset-bottom)', '34px') });
        if (url.hostname === 'source.invalid') {
          downloads++;
          if (holdSource) await new Promise(resolve => { releaseSource = resolve; });
          return route.fulfill({ status: failSource ? 503 : 200, contentType: 'application/octet-stream', body: failSource ? '' : bytes });
        }
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.includes('/functions/')) {
            const body = request.postDataJSON(); actions.push(body.action);
            if (['public-export-source', 'export-source'].includes(body.action)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'https://source.invalid/source.xlsx' }) });
            if (!['public-list', 'list', 'work-areas', 'public-original'].includes(body.action)) writes.push(body.action);
          } else if (request.method() !== 'GET' && !url.pathname.includes('/object/list/')) writes.push(url.pathname);
          return route.fulfill({ contentType: 'application/json', body: '[]' });
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      bytes = Buffer.from(await page.evaluate(() => {
        sb.auth.getSession = async () => ({ data: { session: profileState.user ? { access_token: 'fixture-token' } : null } });
        const headers = ['LATITUDE', 'LONGITUDE', 'ROUTE', 'DAY', 'QTY', 'BINNO', 'CSADR#', 'CSSTRT', 'del_qty', 'del_status', 'Customer notes', 'Unused', 'Duplicate', 'Duplicate', '', 'Formatted ID', 'Formula', 'Long value'];
        const sheet = XLSX.utils.aoa_to_sheet([
          headers,
          [30.75, -98.23, 'Unmapped route', 7, 99, '001', 100, 'Oak', 0, '', '<img src=x onerror=alert(1)>', null, 'First', 'Second', 'No header value', 7, 2, 'Long'.repeat(100)],
          [],
          [30.75, -98.23, 'Unmapped route 2', 6, 88, '002', 100, 'Oak', 0, '', 'Second record', null, 'Third', 'Fourth', 'Other value', 8, 3, 'Tail']
        ]);
        sheet.P2.z = '000000'; sheet.Q2.f = '1+1';
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, 'Stops');
        window.testWorkbook = wb;
        window.loadFixture = (mode = 'original') => {
          profileState.user = mode === 'copy' ? { id: 'fixture', email: 'driver@profiles.cartdelivery.invalid' } : null;
          profileState.workspace = { mode, fileId: mode === 'legacy' ? null : 'fixture', name: 'Sample.xlsx', pending: 0, legacy: mode === 'legacy' };
          if (mode === 'legacy') profileState.workspace.mode = 'original';
          window._currentFilePath = 'Sample.xlsx';
          // Mimic mapped database rows: some source values have been removed or replaced.
          const rows = XLSX.utils.sheet_to_json(wb.Sheets.Stops).map(row => ({ LATITUDE: row.LATITUDE, LONGITUDE: row.LONGITUDE, ROUTE: 'A', DAY: 1, QTY: 3,
            BINNO: row.BINNO, 'CSADR#': row['CSADR#'], CSSTRT: row.CSSTRT, del_qty: 1, delivery_notes: 'Confirmed note' }));
          processExcelBuffer(null, mode === 'legacy' ? wb : profileViewWorkbook(), rows);
          renderProfileState();
          window.openFixtureStop = index => {
            const marker = Object.values(routeDayGroups).flatMap(g => g.layers).find(m => m._rowRef === _currentRows[index]);
            map.setView(marker.getLatLng(), 18, { animate: false }); marker.openPopup();
          };
        };
        loadFixture();
        return Array.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
      }));
      const button = () => page.locator(width === 440 ? '#mobileStopDetails .record-fields-button' : '.leaflet-popup .record-fields-button');
      const open = async (index = 0) => {
        await page.evaluate(index => openFixtureStop(index), index);
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1,
          width === 440 ? '#mobileStopDetails .record-fields-button' : '.leaflet-popup .record-fields-button');
        await button().click();
      };
      const loaded = () => page.waitForFunction(() => document.getElementById('recordFieldsStatus').textContent.includes('fields ·'));
      const fields = () => page.locator('#recordFieldsList > div').evaluateAll(items => items.map(item => [item.querySelector('dt').textContent, item.querySelector('dd').textContent]));
      assert.equal(downloads, 0, 'Source is fetched only on demand');
      const before = await page.evaluate(() => JSON.stringify(_currentRows));
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await open(); await loaded();
        const values = await fields();
        assert.equal(values.length, 18);
        assert(values.some(([key, value]) => key === 'ROUTE' && value === 'Unmapped route'));
        assert(values.some(([key, value]) => key === 'QTY' && value === '99'));
        assert(values.some(([key, value]) => key === 'Customer notes' && value.startsWith('<img')));
        assert(values.some(([key, value]) => key === 'Unused' && value === 'Blank'));
        assert.deepEqual(values.filter(([key]) => key === 'Duplicate').map(([, value]) => value), ['First', 'Second']);
        assert(values.some(([key, value]) => key === 'Column O (no heading)' && value === 'No header value'));
        assert(values.some(([key, value]) => key === 'Formatted ID' && value === '000007'));
        assert(values.some(([key, value]) => key === 'Formula' && value === '2'));
        assert.equal(await page.locator('#recordFieldsList img').count(), 0, 'Source text is never interpreted as HTML');
        assert.match(await page.locator('#recordFieldsCurrent').textContent(), /1 of 3 carts delivered.*Confirmed note/);
        assert.match(await page.locator('#recordFieldsCurrent').textContent(), /Route A · Monday/);
        assert.match(await page.locator('#recordFieldsStatus').textContent(), /Spreadsheet row 2/);
        assert.equal(await page.locator('#selectionCount').textContent(), '0');
        assert.equal(await page.evaluate(() => JSON.stringify(_currentRows)), before);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(await page.locator('#recordFieldsDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        assert((await page.locator('#closeRecordFieldsBtn').boundingBox()).height >= 44);
        await page.screenshot({ path: path.join(root, `local-artifacts/record-fields-${width}-${light ? 'light' : 'dark'}.png`) });
        await page.locator('#recordFieldsList > div').last().scrollIntoViewIfNeeded();
        if (width === 440) {
          const closeBox = await page.locator('#closeRecordFieldsBtn').boundingBox();
          assert(closeBox.y >= 0 && closeBox.y + closeBox.height <= 956, 'Phone Close stays visible while fields scroll');
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('recordFieldsDialog').open);
        assert(await button().evaluate(el => el === document.activeElement), 'Focus returns to the stop');
      }
      assert.equal(downloads, 1, 'Source is reused when inspecting more records');
      assert(actions.includes('public-export-source'));
      await open(1); await loaded();
      assert.match(await page.locator('#recordFieldsIdentity').textContent(), /Bin 002/);
      assert.match(await page.locator('#recordFieldsStatus').textContent(), /Spreadsheet row 4/, 'Blank source rows do not shift record matching');
      assert((await fields()).some(([key, value]) => key === 'Customer notes' && value === 'Second record'));
      await page.locator('#closeRecordFieldsBtn').click();
      await page.evaluate(() => loadFixture('copy'));
      failSource = true;
      await open(); await page.locator('#retryRecordFieldsBtn').waitFor();
      assert.match(await page.locator('#recordFieldsStatus').textContent(), /Could not load/);
      failSource = false;
      await page.locator('#retryRecordFieldsBtn').click(); await loaded();
      assert(actions.includes('export-source'));
      assert.match(await page.locator('#recordFieldsCurrent').textContent(), /Your copy · driver/);
      await page.locator('#closeRecordFieldsBtn').click();
      await page.evaluate(() => loadFixture('legacy'));
      const priorDownloads = downloads;
      await open(); await loaded();
      assert.equal(downloads, priorDownloads, 'Legacy files use the already loaded workbook');
      await page.locator('#closeRecordFieldsBtn').click();
      await page.evaluate(() => { loadFixture(); _currentRows.push({}); });
      await open(); await page.locator('#retryRecordFieldsBtn').waitFor();
      assert.match(await page.locator('#recordFieldsStatus').textContent(), /could not be matched/);
      assert.equal(await page.locator('#recordFieldsList > div').count(), 0);
      await page.locator('#closeRecordFieldsBtn').click();
      await page.evaluate(() => loadFixture());
      holdSource = true;
      await open();
      await page.waitForFunction(() => document.getElementById('recordFieldsStatus').textContent.startsWith('Loading'));
      while (!releaseSource) await new Promise(resolve => setTimeout(resolve, 20));
      await page.evaluate(() => loadFixture('legacy'));
      assert.equal(await page.locator('#recordFieldsDialog').evaluate(el => el.open), false, 'File changes close stale details');
      holdSource = false; releaseSource();
      await open(1); await loaded();
      assert.match(await page.locator('#recordFieldsIdentity').textContent(), /Bin 002/);
      assert((await fields()).some(([key, value]) => key === 'Customer notes' && value === 'Second record'));
      await page.evaluate(() => document.getElementById('resetMapBtn').click());
      assert.equal(await page.locator('#recordFieldsDialog').evaluate(el => el.open), false);
      assert.equal(await page.locator('#recordFieldsList > div').count(), 0);
      await page.evaluate(() => loadFixture());
      failWorker = true; holdSource = true; releaseSource = null;
      await open();
      await page.waitForFunction(() => recordFieldsSource?.error?.message === 'SOURCE_READ_FAILED');
      while (!releaseSource) await new Promise(resolve => setTimeout(resolve, 20));
      holdSource = false; releaseSource();
      await page.locator('#retryRecordFieldsBtn').waitFor({ timeout: 5000 });
      failWorker = false;
      await page.locator('#retryRecordFieldsBtn').click(); await loaded();
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], 'Inspecting fields never writes to the backend');
      await context.close();
      console.log(`PASS ${width}: all source columns, mapped values, blank rows, formatting, overlapping records, lazy cache, retry, stale loads, keyboard focus, themes, and no writes.`);
    }
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
