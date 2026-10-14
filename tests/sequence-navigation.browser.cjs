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
      const errors = [], writes = [];
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname.endsWith('supabase.co') || url.hostname === 'api.optimoroute.com') {
          if (request.method() !== 'GET' && !url.pathname.includes('/object/list/') && !['public-list', 'list', 'work-areas'].includes(request.postDataJSON()?.action)) writes.push(url.pathname);
          return route.fulfill({ contentType: 'application/json', body: '[]' });
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        if (url.pathname.endsWith('/style.css') && width === 440) return route.fulfill({ contentType: 'text/css',
          body: fs.readFileSync(path.join(root, 'style.css'), 'utf8').replaceAll('env(safe-area-inset-top)', '59px').replaceAll('env(safe-area-inset-bottom)', '34px') });
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      assert(await page.locator('#browseSequenceBtn').isDisabled());
      await page.evaluate(() => {
        window.loadNavigationFixture = () => {
          const rows = [10, 2, 0, 2, '', 4, 1, 3].map((SEQNO, ID) => ({ ID, SEQNO, ROUTE: ID === 6 ? 'B' : 'A', DAY: ID === 6 ? 2 : 1,
            NEWROUTE: 'Ignored', NEWDAY: 7, LATITUDE: ID === 7 ? '' : 30.75 + (ID === 3 ? 1 : ID) * .001,
            LONGITUDE: -98.23, 'CSADR#': 100 + ID, CSSTRT: 'Oak', BINNO: `00${ID}`, QTY: ID === 1 ? 1 : 3,
            del_status: ID === 5 ? 'Delivered' : '', del_qty: ID === 5 ? 3 : 0 }));
          const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
          window._currentFilePath = 'Navigation.xlsx';
          profileState.workspace = { mode: 'original', name: 'Navigation.xlsx', legacy: true };
          processExcelBuffer(null, wb, rows);
          document.getElementById('sequenceRouteSelect').value = JSON.stringify(['A', '1']);
          document.getElementById('sequenceLayerToggle').checked = true;
          window.markerById = id => Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef.ID === id);
          individuallySelectedMarkers.add(markerById(0)); updateSelectionCount(); updateUndoButtonState();
          scheduleSequenceRender();
        };
      });
      const card = () => page.locator(width === 440 ? '#mobileStopDetails' : '.leaflet-popup').last();
      const next = () => card().locator('[data-sequence-step="next"]');
      const previous = () => card().locator('[data-sequence-step="previous"]');
      const current = async id => {
        await page.waitForFunction(id => viewedStopMarker?._rowRef.ID === id, id);
        assert.match(await card().locator('.delivery-stop-bin').textContent(), new RegExp(`00${id}`));
        assert(await card().locator('.sequence-stop-nav').isVisible());
        if (width === 440) assert(await page.evaluate(() => {
          const point = map.latLngToContainerPoint(viewedStopMarker.getLatLng());
          const y = point.y + map.getContainer().getBoundingClientRect().top;
          return y > document.querySelector('header').getBoundingClientRect().bottom && y < document.getElementById('mobileStopDetails').getBoundingClientRect().top;
        }), 'Viewed marker stays above the phone sheet');
      };
      const browse = async () => {
        if (width === 440 && !(await page.locator('.sidebar').evaluate(el => el.classList.contains('open')))) await page.locator('#mobileMenuBtn').click();
        if (await page.locator('#deliverySequenceDisclosure').getAttribute('aria-expanded') === 'false') await page.locator('#deliverySequenceDisclosure').click();
        await page.locator('#browseSequenceBtn').click();
      };
      for (const light of [false, true]) {
        await page.evaluate(light => { document.body.classList.toggle('sun-mode', light); loadNavigationFixture(); }, light);
        await page.waitForFunction(() => !document.getElementById('browseSequenceBtn').disabled);
        if (width === 440) {
          await page.locator('#mobileSelectionBtn').click();
          await page.waitForFunction(() => document.getElementById('browseSequenceBtn').disabled);
          assert.match(await page.locator('#browseSequenceStatus').textContent(), /Finish Select Stops/);
          await page.locator('#mobileSelectionBtn').click();
          await page.waitForFunction(() => !document.getElementById('browseSequenceBtn').disabled);
        }
        const before = await page.evaluate(() => ({ rows: JSON.stringify(_currentRows), selected: Object.values(routeDayGroups).flatMap(g => g.layers).filter(m => isStopSelected(m)).map(m => m._rowRef.ID) }));
        await browse(); await current(2);
        if (width === 440) {
          const compact = await card().boundingBox();
          assert(compact.height <= 210, 'Sequence browsing uses a compact phone panel');
          assert(await card().locator('.delivery-stop-address').isVisible());
          assert(await card().locator('.delivery-stop-bin').isVisible());
          assert(await card().locator('.delivery-stop-remaining').isVisible());
          assert.equal(await card().locator('.record-fields-button').isVisible(), false);
          assert((await page.locator('#toggleSequenceDetailsBtn').boundingBox()).height >= 44);
          await page.locator('#toggleSequenceDetailsBtn').click();
          assert.equal(await page.locator('#toggleSequenceDetailsBtn').getAttribute('aria-expanded'), 'true');
          assert(await card().locator('.record-fields-button').isVisible());
          assert((await card().boundingBox()).height > compact.height + 80);
          await page.evaluate(() => {
            profileState.user = { id: 'fixture', email: 'driver@profiles.cartdelivery.invalid' };
            profileState.workspace.mode = 'copy'; refreshMobileStopDetails();
          });
          await card().locator('.stop-delivery-action').click();
          assert(await page.locator('#cartCountsDialog').isVisible(), 'Expanded details retain delivery access');
          assert.equal(await page.locator('#cartCountEntries input').count(), 1);
          await page.locator('#closeCartCountsBtn').click();
          await page.evaluate(() => { profileState.user = null; profileState.workspace.mode = 'original'; refreshMobileStopDetails(); });
          await page.locator('#toggleSequenceDetailsBtn').click();
          assert((await card().boundingBox()).height <= 210);
          await page.locator('#toggleSequenceDetailsBtn').click();
        }
        assert(await previous().isDisabled());
        assert.match(await card().locator('.sequence-stop-label').textContent(), /Original file.*#0/);
        assert.equal(await card().locator('.sequence-stop-position').textContent(), '1 of 4');
        await next().click(); await current(1);
        if (width === 440) {
          assert.equal(await page.locator('#toggleSequenceDetailsBtn').getAttribute('aria-expanded'), 'false');
          assert((await card().boundingBox()).height <= 210, 'Next returns to compact browsing');
        }
        await next().click(); await current(3);
        assert.equal(await page.locator('#mobileStopPicker').isVisible(), false, 'Exact sequence navigation bypasses the overlap chooser');
        assert.match(await card().locator('.sequence-stop-label').textContent(), /#2/);
        await next().click(); await current(0);
        assert(await next().isDisabled());
        assert.equal(await card().locator('.sequence-stop-position').textContent(), '4 of 4');
        await previous().focus(); await page.keyboard.press('Enter'); await current(3);
        assert(await previous().evaluate(el => el === document.activeElement));
        assert((await next().boundingBox()).height >= 44);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.waitForFunction(() => !map._panAnim?._inProgress && [...document.querySelectorAll('.leaflet-popup')].every(el => Number(getComputedStyle(el).opacity) === 1));
        const navBox = await card().locator('.sequence-stop-nav').boundingBox();
        assert(navBox.y >= await page.locator('header').evaluate(el => el.getBoundingClientRect().bottom), 'Navigation stays below the header');
        await page.screenshot({ path: path.join(root, `local-artifacts/sequence-navigation-${width}-${light ? 'light' : 'dark'}.png`) });
        assert.deepEqual(await page.evaluate(() => ({ rows: JSON.stringify(_currentRows), selected: Object.values(routeDayGroups).flatMap(g => g.layers).filter(m => isStopSelected(m)).map(m => m._rowRef.ID) })), before);
        // Live map filtering changes the traversal without resetting or renumbering the source.
        await page.evaluate(() => { document.getElementById('multipleCartsOnly').checked = true; applyFilters(); });
        await previous().click(); await current(2);
        await next().click(); await current(3);
        assert.equal(await card().locator('.sequence-stop-position').textContent(), '2 of 3');
        await page.evaluate(() => { document.getElementById('multipleCartsOnly').checked = false; applyFilters(); });
        // Phone details remain after a marker hides; desktop retains its usual popup dismissal.
        await page.evaluate(() => { map.removeLayer(markerById(3)); scheduleSequenceRender(); });
        if (width === 440) {
          await page.waitForFunction(() => [...document.querySelectorAll('.sequence-stop-position')].some(node => node.textContent.startsWith('Hidden')));
          await next().click(); await current(0);
        } else {
          await page.waitForFunction(() => !document.querySelector('.leaflet-popup'));
          await browse(); await current(2);
          await next().click(); await current(1);
          await next().click(); await current(0);
        }
        await page.evaluate(() => { applyFilters(); applyPhoneSequence(_currentRows, { version: 2, groups: [
          { route: 'A', day: '1', indices: [0, 3, 1], sequences: [1, 4, 9] }, { route: 'B', day: '2', indices: [6], sequences: [2] }
        ] }); });
        await browse(); await current(0);
        assert.match(await card().locator('.sequence-stop-label').textContent(), /Saved Optimo.*#1/);
        assert.equal(await card().locator('.sequence-stop-position').textContent(), '1 of 3');
        await next().click(); await current(3);
        assert.match(await card().locator('.sequence-stop-label').textContent(), /#4/);
        await next().click(); await current(1);
        assert.match(await card().locator('.sequence-stop-label').textContent(), /#9/);
        assert(await next().isDisabled(), 'Unscheduled Excel records are not appended to Optimo order');
        await page.evaluate(() => { document.getElementById('sequenceRouteSelect').value = 'all'; document.getElementById('sequenceRouteSelect').dispatchEvent(new Event('change')); });
        await page.waitForFunction(() => [...document.querySelectorAll('.sequence-stop-position')].some(node => node.textContent === '3 of 4'));
        await next().click(); await current(6);
        assert.match(await card().locator('.sequence-stop-label').textContent(), /Route B.*Tuesday.*#2/);
        assert(await next().isDisabled());
        await page.evaluate(() => { document.getElementById('sequenceRouteSelect').value = JSON.stringify(['B', '2']); scheduleSequenceRender(); });
        await page.waitForFunction(() => [...document.querySelectorAll('.sequence-stop-position')].some(node => node.textContent === '1 of 1'));
        assert(await previous().isDisabled()); assert(await next().isDisabled());
        await page.evaluate(() => { document.querySelector('#routeCheckboxes input[value="B"]').checked = false; applyFilters(); });
        await page.waitForFunction(() => document.getElementById('browseSequenceBtn').disabled);
        await page.evaluate(() => { document.getElementById('sequenceSource').value = 'original'; document.getElementById('sequenceSource').dispatchEvent(new Event('change')); });
        await page.evaluate(() => document.getElementById('resetMapBtn').click());
        await page.waitForFunction(() => document.getElementById('browseSequenceBtn').disabled);
        assert.equal(await page.locator('#mobileStopDetails').isVisible(), false);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
      await context.close();
      console.log(`PASS ${width}: original/Optimo order, duplicate and missing numbers, filtered and overlapping stops, route groups, endpoints, selection preservation, keyboard, themes, safe areas, and no backend writes.`);
    }
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
