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
    const checkViewedStop = async id => {
      assert.equal(await page.locator('.viewed-stop-ring').count(), 1);
      const state = await page.evaluate(() => {
        const target = getLayerLatLng(viewedStopMarker);
        const point = map.latLngToContainerPoint(target), box = map.getContainer().getBoundingClientRect();
        const ring = viewedStopIndicator.getElement().getBoundingClientRect();
        return { id: viewedStopMarker._rowRef.ID, sameLocation: viewedStopIndicator.getLatLng().equals(target),
          offset: Math.hypot(ring.x + ring.width / 2 - box.x - point.x, ring.y + ring.height / 2 - box.y - point.y),
          interactive: viewedStopIndicator.options.interactive };
      });
      assert.equal(state.id, id); assert(state.sameLocation); assert(state.offset < 2); assert.equal(state.interactive, false);
    };
    assert.equal(await page.locator('#completeStopsBtnMobile').isVisible(), false);
    assert.deepEqual(await page.locator('#deliveryQuickActions > button').evaluateAll(buttons => buttons.map(b => b.id)), ['mobileMenuBtn', 'locateMeBtn', 'mobileSelectionBtn', 'deliveryMoreBtn']);
    assert.equal(await page.locator('#copyLocationBtn').isVisible(), false);
    assert.equal(await page.locator('#mapScopeChip').textContent(), 'Route A · Monday · Pending');
    await page.locator('#mapScopeChip').click();
    assert(await page.locator('.sidebar').evaluate(el => el.classList.contains('open')));
    assert(await page.locator('#mapFiltersSection').evaluate(el => el.open));
    assert(await page.locator('#routeDayLayers input').first().isVisible());
    await page.locator('#mobileMenuBtn').click();
    await page.evaluate(() => {
      document.querySelector('#dayCheckboxes input[value="1"]').checked = false; applyFilters();
    });
    assert.match(await page.locator('#mapScopeChip').textContent(), /No active layers/);
    await page.evaluate(() => {
      document.querySelector('#dayCheckboxes input[value="1"]').checked = true; applyFilters();
      const polygon = L.rectangle([[30.749, -98.231], [30.752, -98.229]]);
      drawnLayer.addLayer(polygon); updateSelectionCount(); updateUndoButtonState();
    });
    assert.equal(await page.locator('#selectionTotals').textContent(), '2 stops · 6 carts remaining');
    await page.evaluate(() => { individuallyDeselectedMarkers.add(testMarker()); updateSelectionCount(); updateUndoButtonState(); });
    assert.equal(await page.locator('#selectionTotals').textContent(), '1 stop · 3 carts remaining');
    await page.evaluate(() => {
      _currentRows[1].QTY = ''; updateSelectionCount(); updateUndoButtonState();
    });
    assert.match(await page.locator('#selectionTotals').textContent(), /0 known carts remaining · 1 missing QTY/);
    await page.evaluate(() => { _currentRows[1].QTY = 3; });
    await page.locator('#cancelSelectionBtn').click();
    assert.equal(await page.locator('#selectionCount').textContent(), '0');
    assert.equal(await page.evaluate(() => drawnLayer.getLayers().length), 0);
    for (const light of [false, true]) {
      await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
      await tapStop();
      await page.waitForFunction(() => !document.querySelector('.leaflet-popup'));
      await checkViewedStop(0);
      const originalColor = await page.evaluate(() => testMarker().options.color);
      await page.evaluate(() => {
        map.panBy([20, 15], { animate: false }); map.setZoom(17, { animate: false });
      });
      await checkViewedStop(0);
      await page.evaluate(() => Object.values(routeDayGroups).flatMap(g => g.layers).find(m => m._rowRef.ID === 1).openPopup());
      await checkViewedStop(1);
      assert.match(await page.locator('#mobileStopDetails').textContent(), /Bin #: 001/);
      await page.evaluate(() => testMarker().openPopup());
      await checkViewedStop(0);
      assert.equal(await page.evaluate(() => testMarker().options.color), originalColor, 'Viewing leaves marker style unchanged');
      assert.equal(await page.locator('#selectionCount').textContent(), '0');
      assert.match(await page.locator('#mobileStopDetails').textContent(), /Bin #: 000/);
      const sheet = await page.locator('#mobileStopDetails').boundingBox();
      const dock = await page.locator('#deliveryControls').boundingBox();
      assert(sheet.y > 350 && sheet.y + sheet.height <= dock.y);
      await inViewport('#mobileStopDetails .stop-delivery-action');
      assert((await page.locator('#mobileStopDetails .stop-delivery-action').boundingBox()).height >= 48);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(root, `local-artifacts/phone-flow-stop-${light}.png`) });
      await page.locator('#closeMobileStopDetails').click();
      assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    }
    await tapStop();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    await tapStop();
    await page.locator('#mobileMenuBtn').click();
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    await page.locator('#mobileMenuBtn').click();
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
    assert(await page.locator('#reloadCartCountCopyBtn').isVisible());
    assert.match(await page.locator('#mobileStopDetails .delivery-feedback').textContent(), /Save not confirmed/);
    assert.match(await page.locator('#mobileStopDetails').textContent(), /3 carts remaining/);
    await checkViewedStop(0);
    await page.locator('#closeCartCountsBtn').click();
    assert(await page.locator('#mobileStopDetails .delivery-feedback button').isVisible());
    await page.locator('#mobileStopDetails .stop-delivery-action').click();
    assert.equal(await page.locator('#cartCountEntries input').inputValue(), '1', 'Single-stop delivery defaults to one cart');
    await page.locator('#saveCartCountsBtn').click();
    await page.waitForFunction(() => deliverySaveInProgress);
    await page.evaluate(() => finishSave(false));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.equal(await page.evaluate(() => _currentRows[0].del_qty), 1);
    assert.match(await page.locator('#mobileStopDetails').textContent(), /2 carts remaining/);
    await checkViewedStop(0);
    assert.match(await page.locator('#reviewSaveStatusBtn').textContent(), /Saved to your copy · 1 stop awaiting sync/);
    assert.equal(await page.locator('#reviewSaveStatusBtn').getAttribute('data-save-state'), 'copy');
    assert.match(await page.locator('#mobileStopDetails .delivery-feedback').textContent(), /Saved to your copy/);
    await page.locator('#mobileSelectionBtn').click();
    assert.equal(await page.locator('#mobileStopDetails').isVisible(), false);
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    await page.evaluate(() => { individuallySelectedMarkers.add(testMarker()); updateSelectionCount(); updateUndoButtonState(); });
    assert.equal(await page.locator('#selectionTotals').textContent(), '1 stop · 2 carts remaining');
    assert.equal(await page.locator('#completeStopsBtnMobile').isVisible(), false);
    assert.equal(await page.locator('#mobileSelectionBtn').textContent(), 'Done');
    for (const width of [360, 1440, 440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await page.waitForTimeout(250);
        await inViewport('#cancelSelectionBtn');
        assert((await page.locator('#cancelSelectionBtn').boundingBox()).height >= 44);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(root, `local-artifacts/workflow-selection-${width}-${light}.png`) });
      }
    }
    await page.locator('#mobileSelectionBtn').click();
    assert(await page.locator('#completeStopsBtnMobile').isVisible());
    assert.equal(await page.evaluate(() => _currentRows[0].del_qty), 1, 'Done does not record a delivery');
    assert.equal(await page.locator('#completeStopsBtnMobile').textContent(), 'Deliver 1 cart each · 1 stop');
    await page.locator('#deliveryMoreBtn').click();
    assert(await page.locator('#copyLocationBtn').isVisible());
    await page.locator('#clearSelectionBtn').click();
    assert.equal(await page.locator('#completeStopsBtnMobile').isVisible(), false);
    await page.locator('#deliveryMoreBtn').click();
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
    await checkViewedStop(0);
    await page.evaluate(() => map.closePopup());
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    await page.evaluate(() => testMarker().openPopup());
    assert.equal(await page.locator('#mobileStopDetails').isVisible(), false);
    assert.equal(await page.locator('#copyLocationBtn').evaluate(el => el.parentElement.id), 'desktopLocateContainer');
    assert.equal(await page.locator('#selectionSummary').evaluate(el => el.parentElement.id), 'selectionBox');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(root, 'local-artifacts/phone-flow-desktop.png') });
    await page.setViewportSize({ width: 440, height: 956 });
    await page.locator('#mobileStopDetails').waitFor();
    await checkViewedStop(0);
    assert.equal(await page.locator('#copyLocationBtn').evaluate(el => el.parentElement.id), 'deliveryMoreActions');
    assert.equal(await page.locator('#selectionSummary').evaluate(el => el.parentElement.id), 'deliveryControls');
    await page.evaluate(() => {
      deliveryFeedback.set(testMarker()._rowRef, { state: 'error' }); refreshMobileStopDetails();
      window.reloadCount = 0;
      openProfileFile = async () => {
        reloadCount++;
        const rows = _currentRows.map(row => ({ ...row, del_qty: row.ID === 0 ? 2 : 0 }));
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
        processExcelBuffer(null, wb, rows);
      };
    });
    for (const width of [440, 360]) {
      await page.setViewportSize({ width, height: 956 });
      await page.waitForTimeout(350);
      await inViewport('#mobileStopDetails .delivery-feedback button');
      assert((await page.locator('#mapScopeChip').boundingBox()).height >= 44);
      await page.screenshot({ path: path.join(root, `local-artifacts/workflow-save-error-${width}.png`) });
    }
    await page.locator('#mobileStopDetails .delivery-feedback button').click();
    assert.equal(await page.evaluate(() => reloadCount), 1);
    assert.match(await page.locator('#mobileStopDetails').textContent(), /1 cart remaining/);
    assert.equal(await page.locator('#mobileStopDetails .delivery-feedback').isVisible(), false);
    await page.evaluate(() => {
      profileState.workspace.pending = 0;
      profileState.workspace.lastSyncedAt = '2026-10-13T12:00:00Z'; renderProfileState();
    });
    assert.equal(await page.locator('#reviewSaveStatusBtn').getAttribute('data-save-state'), 'synced');
    assert.match(await page.locator('#reviewSaveStatusBtn').textContent(), /Synced to team/);
    await page.evaluate(() => {
      const rows = _currentRows.map(row => ({ ...row, ROUTE: row.ID === 0 ? 'A' : 'B', DAY: row.ID === 0 ? 1 : 2, NEWROUTE: 'IGNORED', NEWDAY: 7 }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      processExcelBuffer(null, wb, rows);
    });
    assert.match(await page.locator('#mapScopeChip').textContent(), /2 routes · 2 days/);
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0, 'Changing files clears the viewed record');
    await page.evaluate(() => Object.values(routeDayGroups).flatMap(g => g.layers).find(m => m._rowRef.ID === 1).openPopup());
    await checkViewedStop(1);
    await page.locator('#closeMobileStopDetails').click();
    await page.evaluate(() => {
      document.querySelector('#routeCheckboxes input[value="B"]').checked = false; applyFilters();
      document.getElementById('multipleCartsOnly').checked = true; applyFilters();
    });
    assert.equal(await page.locator('#mapScopeChip').textContent(), 'Route A · Monday · Pending · QTY 2+');
    await page.evaluate(() => {
      const rows = _currentRows.map(row => ({ ...row, del_qty: row.ID === 0 ? 3 : 0 }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      processExcelBuffer(null, wb, rows);
      document.querySelector('#routeCheckboxes input[value="B"]').checked = false;
      const input = document.querySelector('#deliveredControls input[data-key="A|Delivered"]');
      input.checked = true; input.dispatchEvent(new Event('change'));
    });
    assert.match(await page.locator('#mapScopeChip').textContent(), /Route A · Monday · Delivered/);
    await page.evaluate(() => {
      closeMobileStopDetails(); profileState.workspace.mode = 'original'; renderProfileState(); testMarker().openPopup();
    });
    assert.match(await page.locator('#mobileStopDetails').textContent(), /View only/);
    assert.equal(await page.locator('#mobileStopDetails .stop-delivery-action').count(), 0);
    assert(await page.locator('#reviewSaveStatusBtn').isDisabled());
    await page.setViewportSize({ width: 360, height: 780 });
    await inViewport('#closeMobileStopDetails');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => document.getElementById('resetMapBtn').click());
    assert.equal(await page.locator('#mapScopeChip').isVisible(), false);
    assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
    await page.evaluate(() => {
      const rows = [0, 1, 2, 3].map(ID => ({ ID, ROUTE: ID === 2 ? 'B' : 'A', DAY: ID === 2 ? 2 : 1,
        NEWROUTE: 'IGNORED', NEWDAY: 7, QTY: 3, del_qty: ID === 3 ? 3 : 0, BINNO: ['001', '002', 0, 'HIDDEN'][ID],
        'CSADR#': 100, CSSTRT: 'Oak', LATITUDE: 30.75, LONGITUDE: -98.23 }));
      layerVisibilityState = {}; document.getElementById('multipleCartsOnly').checked = false;
      profileState.workspace.mode = 'copy';
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
      processExcelBuffer(null, wb, rows); renderProfileState();
      map.setView([30.75, -98.23], 18, { animate: false });
    });
    const tapOverlap = async () => {
      const point = await page.evaluate(() => {
        map.setView([30.75, -98.23], 18, { animate: false });
        const p = map.latLngToContainerPoint([30.75, -98.23]), box = map.getContainer().getBoundingClientRect();
        return { x: box.x + p.x, y: box.y + p.y };
      });
      if (page.viewportSize().width <= 900) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await page.locator('#mobileStopPicker').waitFor();
    };
    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await page.evaluate(light => { document.body.classList.toggle('sun-mode', light); map.closePopup(); closeMobileStopDetails(); }, light);
        await page.waitForTimeout(250);
        await tapOverlap();
        assert.equal(await page.locator('.mobile-stop-choice').count(), 3, 'Hidden delivered record is excluded');
        assert.equal(await page.locator('#selectionCount').textContent(), '0', 'Opening a stack never selects its top record');
        assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
        assert((await page.locator('.mobile-stop-choice-bin').allTextContents()).includes('Bin #: 0'));
        assert.match(await page.locator('#mobileStopPicker').textContent(), /Route B · Tuesday/);
        assert(!/IGNORED|HIDDEN/.test(await page.locator('#mobileStopPicker').textContent()));
        await inViewport('#mobileStopPickerClose');
        assert((await page.locator('#mobileStopPickerClose').boundingBox()).height >= 44);
        await page.screenshot({ path: path.join(root, `local-artifacts/overlap-picker-${width}-${light}.png`) });
        await page.locator('.mobile-stop-choice').filter({ hasText: 'Bin #: 002' }).click();
        if (width > 900) await page.waitForFunction(() => document.querySelectorAll('.leaflet-popup').length === 1);
        await checkViewedStop(1);
        assert.equal(await page.locator('#selectionCount').textContent(), '0');
        const card = page.locator(width <= 900 ? '#mobileStopDetails' : '.leaflet-popup');
        assert.match(await card.textContent(), /Bin #: 002/);
        await card.locator('.choose-overlapping-stop').click();
        await page.locator('.mobile-stop-choice').filter({ has: page.getByText('Bin #: 0', { exact: true }) }).click();
        if (width > 900) await page.waitForFunction(() => document.querySelectorAll('.leaflet-popup').length === 1);
        await checkViewedStop(2);
        assert.match(await card.textContent(), /Route B · Tuesday/);
        if (width > 900) {
          await card.locator('.select-overlapping-stop').click();
          assert.equal(await page.locator('#selectionCount').textContent(), '1');
          assert.equal(await page.evaluate(() => [...individuallySelectedMarkers][0]._rowRef.ID), 2);
          await card.locator('.select-overlapping-stop').click();
          assert.equal(await page.locator('#selectionCount').textContent(), '0');
        }
        await card.locator('.choose-overlapping-stop').click();
        await page.locator('#mobileStopPickerClose').click();
        assert.equal(await page.locator('#selectionCount').textContent(), '0');
        assert.equal(await page.locator('.viewed-stop-ring').count(), 0);
      }
    }
    await page.setViewportSize({ width: 440, height: 956 });
    await page.waitForTimeout(250);
    await page.locator('#mobileSelectionBtn').click();
    await tapOverlap();
    assert.equal(await page.locator('#mobileStopPicker').getAttribute('data-mode'), 'select');
    await page.locator('.mobile-stop-choice').filter({ hasText: 'Bin #: 002' }).click();
    assert.equal(await page.locator('#selectionCount').textContent(), '1');
    assert.equal(await page.evaluate(() => [...individuallySelectedMarkers][0]._rowRef.ID), 1);
    await page.locator('#cancelSelectionBtn').click();
    await tapOverlap();
    await page.locator('.mobile-stop-choice').filter({ hasText: 'Bin #: 002' }).click();
    await page.locator('#mobileStopDetails .stop-delivery-action').click();
    assert.equal(await page.locator('#cartCountEntries input').inputValue(), '1', 'Reopening starts with one cart');
    await page.locator('#saveCartCountsBtn').click();
    await page.waitForFunction(() => deliverySaveInProgress);
    assert.deepEqual(await page.evaluate(() => _currentRows.map(row => row.del_qty)), [0, 0, 0, 3]);
    await page.evaluate(() => finishSave(false));
    await page.waitForFunction(() => !deliverySaveInProgress);
    assert.deepEqual(await page.evaluate(() => _currentRows.map(row => row.del_qty)), [0, 1, 0, 3], 'Only the chosen overlapping record changes after confirmation');
    await page.locator('#mobileStopDetails .choose-overlapping-stop').click();
    await page.evaluate(() => { document.querySelector('#routeCheckboxes input[value="B"]').checked = false; applyFilters(); });
    assert.equal(await page.locator('#mobileStopPicker').isVisible(), false, 'Filter changes dismiss stale choices');
    await tapOverlap();
    assert.equal(await page.locator('.mobile-stop-choice').count(), 2);
    await page.evaluate(() => document.getElementById('resetMapBtn').click());
    assert.equal(await page.locator('#mobileStopPicker').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS route/day chip, polygon and partial-cart totals, Done/Cancel, failed-save recovery, copy/sync indicators, phone stop sheet, keyboard viewport, and desktop placement');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
