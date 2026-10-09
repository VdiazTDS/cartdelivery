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
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
        { ROUTE: 'TEST', DAY: 1, SEQNO: 1, LATITUDE: 30.75, LONGITUDE: -98.23, 'CSADR#': 123, CSSTRT: 'TEST', QTY: 2 }
      ]), 'Stops');
      processExcelBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
      const marker = Object.values(routeDayGroups).flatMap(group => group.layers).find(item => item._rowRef);
      individuallySelectedMarkers.add(marker);
      updateSelectionCount();
      updateUndoButtonState();
      window.pocketTestClicks = 0;
      document.getElementById('clearSelectionBtn').addEventListener('click', () => window.pocketTestClicks++);
      document.getElementById('map').addEventListener('click', () => window.pocketTestClicks++);
    });
    const snapshot = () => page.evaluate(() => ({
      selected: Object.values(routeDayGroups).flatMap(group => group.layers).filter(marker => isStopSelected(marker)).length,
      rows: JSON.stringify(window._currentRows), clicks: window.pocketTestClicks
    }));
    const before = await snapshot();
    assert.equal(before.selected, 1);
    const locked = async () => assert.equal(await page.locator('#pocketLock').evaluate(el => el.open), true);
    const unlockPoint = async () => {
      const box = await page.locator('#pocketUnlockBtn').boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const mouseHold = async (duration, move = false) => {
      const p = await unlockPoint();
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      if (move) await page.mouse.move(p.x + 30, p.y);
      await page.waitForTimeout(duration);
      await page.mouse.up();
    };
    for (const width of [440, 1440]) {
      await page.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await page.evaluate(value => document.body.classList.toggle('sun-mode', value), light);
        const lock = await page.locator('#lockScreenBtn').boundingBox();
        const toggle = await page.locator('.theme-toggle').boundingBox();
        assert(lock.width >= 44 && lock.height >= 44);
        assert(lock.x >= toggle.x + toggle.width && Math.abs(lock.y - toggle.y) < 3);
        assert(lock.x - toggle.x - toggle.width < 12);
        assert(width - lock.x - lock.width <= 12);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(root, `local-artifacts/pocket-header-${width}-${light}.png`) });
        const mapBox = await page.locator('#map').boundingBox();
        const clip = { x: Math.round(mapBox.x + mapBox.width / 2 - 50), y: Math.round(mapBox.y + mapBox.height / 2 - 50), width: 100, height: 100 };
        const visibleMap = await page.screenshot({ clip });
        await page.locator('#lockScreenBtn').click();
        await locked();
        assert.deepEqual(await page.screenshot({ clip }), visibleMap, 'Map must remain visible without dimming or covering the center');
        const panel = await page.locator('.pocket-lock-content').boundingBox();
        assert(panel.y > clip.y + clip.height, 'Unlock panel stays below the map center');
        const action = await page.locator(width <= 900 ? '#completeStopsBtnMobile' : '#clearSelectionBtn').boundingBox();
        await page.mouse.click(action.x + action.width / 2, action.y + action.height / 2);
        await page.mouse.move(clip.x + 50, clip.y + 50);
        await page.mouse.down();
        await page.mouse.move(clip.x + 100, clip.y + 100, { steps: 5 });
        await page.mouse.up();
        assert.deepEqual(await page.screenshot({ clip }), visibleMap, 'Locked map cannot pan');
        assert.deepEqual(await snapshot(), before);
        await page.mouse.click(20, 150);
        await page.locator('#pocketUnlockBtn').click();
        await page.keyboard.press('Escape');
        await locked();
        await mouseHold(150);
        await locked();
        await mouseHold(2100, true);
        await locked();
        await page.screenshot({ path: path.join(root, `local-artifacts/pocket-locked-${width}-${light}.png`) });
        await mouseHold(2100);
        await page.waitForFunction(() => !document.getElementById('pocketLock').open);
        assert.deepEqual(await snapshot(), before);
      }
    }
    await page.setViewportSize({ width: 440, height: 956 });
    await page.locator('#lockScreenBtn').tap();
    const cdp = await context.newCDPSession(page);
    const p = await unlockPoint();
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [{ ...p, id: 1 }]);
    await page.waitForTimeout(100);
    await touch('touchStart', [{ ...p, id: 1 }, { x: p.x + 60, y: p.y, id: 2 }]);
    await page.waitForTimeout(2100);
    await touch('touchEnd', []);
    await locked();
    await touch('touchStart', [{ ...p, id: 1 }]);
    await touch('touchCancel', []);
    await page.waitForTimeout(2100);
    await locked();
    await page.keyboard.down('Space');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(2100);
    await page.keyboard.up('Space');
    await locked();
    await touch('touchStart', [{ ...p, id: 1 }]);
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#pocketLockStatus').textContent(), 'Release to unlock');
    await locked();
    await touch('touchEnd', []);
    await page.waitForFunction(() => !document.getElementById('pocketLock').open);
    assert.deepEqual(await snapshot(), before);
    await page.locator('#lockScreenBtn').click();
    await page.keyboard.down('Enter');
    await page.waitForTimeout(2100);
    await page.keyboard.up('Enter');
    await page.waitForFunction(() => !document.getElementById('pocketLock').open);
    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#lockScreenBtn').click();
    await page.setViewportSize({ width: 956, height: 440 });
    await locked();
    const bounds = await page.locator('#pocketLock').boundingBox();
    assert.deepEqual(bounds, { x: 0, y: 0, width: 956, height: 440 });
    assert.deepEqual(errors, []);
    console.log('PASS: phone/desktop, both themes, header placement, taps, swipes, multi-touch, cancellation, keyboard, touch hold, resize, and selection/data preservation.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
