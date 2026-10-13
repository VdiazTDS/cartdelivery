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
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const rows = [0, 1].map(ID => ({ ID, ROUTE: 'A', DAY: 1, QTY: 3, del_qty: 0, BINNO: `00${ID}`, 'CSADR#': 100 + ID, CSSTRT: 'Oak', LATITUDE: 30.75 + ID * .001, LONGITUDE: -98.23 }));
      profileState.user = { id: 'sample', email: 'driver@profiles.cartdelivery.invalid' };
      profileState.workspace = { mode: 'copy', name: 'Sample.xlsx', fileId: 'sample', pending: 0 };
      window._currentFilePath = 'Sample.xlsx';
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      processExcelBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      renderProfileState();
      window.testMarker = () => Object.values(routeDayGroups).flatMap(g => g.layers).find(m => m._rowRef.ID === 0);
      saveProfileWorkbook = (rows, workbook) => new Promise((resolve, reject) => {
        window.finishSave = fail => {
          if (fail) reject(new Error('Simulated failure'));
          else { profileState.workspace.pending = 1; resolve(workbook); }
        };
      });
    });
    const tapStop = async () => {
      const point = await page.evaluate(() => {
        map.setView(testMarker().getLatLng(), 18, { animate: false });
        const p = map.latLngToContainerPoint(testMarker().getLatLng());
        const box = document.getElementById('map').getBoundingClientRect();
        return { x: p.x + box.x, y: p.y + box.y };
      });
      await page.touchscreen.tap(point.x, point.y);
      await page.locator('#mobileStopDetails').waitFor();
    };
    const inViewport = async selector => {
      const box = await page.locator(selector).boundingBox();
      const viewport = await page.evaluate(() => ({ top: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height }));
      assert(box && box.y >= viewport.top - 1 && box.y + box.height <= viewport.bottom + 1, `${selector} within visual viewport`);
    };
    assert.equal(await page.locator('#completeStopsBtnMobile').isVisible(), false);
    assert.deepEqual(await page.locator('#deliveryQuickActions > button').evaluateAll(buttons => buttons.map(b => b.id)), ['mobileMenuBtn', 'locateMeBtn', 'mobileSelectionBtn', 'deliveryMoreBtn']);
    assert.equal(await page.locator('#copyLocationBtn').isVisible(), false);
    for (const light of [false, true]) {
      await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
      await tapStop();
      await page.waitForFunction(() => !document.querySelector('.leaflet-popup'));
      assert.equal(await page.locator('#selectionCount').textContent(), '0');
      assert.match(await page.locator('#mobileStopDetails').textContent(), /Bin #: 000/);
      const sheet = await page.locator('#mobileStopDetails').boundingBox();
      const dock = await page.locator('#deliveryControls').boundingBox();
      assert(sheet.y > 350 && sheet.y + sheet.height <= dock.y);
      await inViewport('#mobileStopDetails .stop-delivery-action');
      assert((await page.locator('#mobileStopDetails .stop-delivery-action').boundingBox()).height >= 48);
      await page.screenshot({ path: path.join(root, `local-artifacts/phone-flow-stop-${light}.png`) });
      await page.locator('#closeMobileStopDetails').click();
    }
    await tapStop();
    await page.locator('#mobileStopDetails .stop-delivery-action').click();
    assert.equal(await page.locator('#cartCountEntries input').count(), 1);
    await page.locator('#cartCountEntries input').fill('1');
    await inViewport('#saveCartCountsBtn');
    await page.locator('#saveCartCountsBtn').click();
    await page.waitForFunction(() => typeof finishSave === 'function');
    assert.equal(await page.evaluate(() => _currentRows[0].del_qty), 0);
    assert.match(await page.locator('#reviewSaveStatusBtn').textContent(), /Saving/);
    await page.evaluate(() => finishSave(true));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => _currentRows[0].del_qty), 0);
    assert.match(await page.locator('#reviewSaveStatusBtn').textContent(), /Save not confirmed/);
    await page.locator('#saveCartCountsBtn').click();
    await page.waitForFunction(() => deliverySaveInProgress);
    await page.evaluate(() => finishSave(false));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => _currentRows[0].del_qty), 1);
    assert.match(await page.locator('#mobileStopDetails').textContent(), /2 carts remaining/);
    assert.match(await page.locator('#reviewSaveStatusBtn').textContent(), /Saved to your copy · 1 stop awaiting sync/);
    await page.locator('#mobileSelectionBtn').click();
    assert.equal(await page.locator('#mobileStopDetails').isVisible(), false);
    await page.evaluate(() => { individuallySelectedMarkers.add(testMarker()); updateSelectionCount(); updateUndoButtonState(); });
    assert.equal(await page.locator('#completeStopsBtnMobile').textContent(), 'Deliver 1 cart each · 1 stop');
    await page.locator('#deliveryMoreBtn').click();
    assert(await page.locator('#copyLocationBtn').isVisible());
    await page.locator('#clearSelectionBtn').click();
    assert.equal(await page.locator('#completeStopsBtnMobile').isVisible(), false);
    await page.locator('#deliveryMoreBtn').click();
    await page.locator('#mobileSelectionBtn').click();
    await page.evaluate(() => {
      window.reviewOpened = 0;
      reviewProfileSync = async () => { reviewOpened++; document.getElementById('profileDialog').close(); document.getElementById('profileSyncDialog').showModal(); };
    });
    await page.locator('#reviewSaveStatusBtn').click();
    assert.equal(await page.evaluate(() => reviewOpened), 1);
    await page.locator('#closeProfileSyncBtn').click();
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    for (const [dialog, action, close] of [
      ['profileDialog', '#profileReviewBtn', '#closeProfileBtn'],
      ['profileSyncDialog', '#confirmProfileSyncBtn', '#closeProfileSyncBtn'],
      ['profileShareDialog', '#commitProfileShareBtn', '#cancelProfileShareBtn'],
      ['teamUploadDialog', '#confirmTeamUploadBtn', '#closeTeamUploadBtn'],
      ['cartCountsDialog', '#saveCartCountsBtn', '#closeCartCountsBtn']
    ]) {
      await page.evaluate(id => {
        const dialog = document.getElementById(id), body = dialog.querySelector('.phone-dialog-body');
        const filler = document.createElement('p'); filler.textContent = 'Long content '.repeat(300); filler.dataset.test = 'filler'; body.append(filler);
        dialog.showModal(); body.scrollTop = body.scrollHeight;
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 480 });
        Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 30 });
        visualViewport.dispatchEvent(new Event('resize'));
      }, dialog);
      await inViewport(action); await inViewport(close);
      await page.screenshot({ path: path.join(root, `local-artifacts/phone-flow-${dialog}-keyboard.png`) });
      await page.evaluate(id => {
        const dialog = document.getElementById(id); dialog.close(); dialog.querySelector('[data-test="filler"]').remove();
        delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize'));
      }, dialog);
    }
    await page.setViewportSize({ width: 1440, height: 956 });
    await page.evaluate(() => testMarker().openPopup());
    assert(await page.locator('.leaflet-popup .delivery-stop-card').isVisible());
    assert.equal(await page.locator('#mobileStopDetails').isVisible(), false);
    assert.equal(await page.locator('#copyLocationBtn').evaluate(el => el.parentElement.id), 'desktopLocateContainer');
    await page.screenshot({ path: path.join(root, 'local-artifacts/phone-flow-desktop.png') });
    await page.setViewportSize({ width: 440, height: 956 });
    await page.locator('#mobileStopDetails').waitFor();
    assert.equal(await page.locator('#copyLocationBtn').evaluate(el => el.parentElement.id), 'deliveryMoreActions');
    await page.evaluate(() => {
      closeMobileStopDetails(); profileState.workspace.mode = 'original'; renderProfileState(); testMarker().openPopup();
    });
    assert.match(await page.locator('#mobileStopDetails').textContent(), /View only/);
    assert.equal(await page.locator('#mobileStopDetails .stop-delivery-action').count(), 0);
    assert(await page.locator('#reviewSaveStatusBtn').isDisabled());
    await page.setViewportSize({ width: 360, height: 780 });
    await inViewport('#closeMobileStopDetails');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS phone stop sheet, confirmed saves, dock, sync shortcut, keyboard viewport, pinned dialog actions, desktop placement');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
