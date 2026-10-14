const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./profile-data.fixture.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html'));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  const fx = await fixture(); let browser;
  try {
    const owner = await fx.actor('file_owner'), driver = await fx.actor('any_driver');
    const rows = [{ QTY: 3, LATITUDE: 30.75, LONGITUDE: -98.23, ROUTE: 'A', DAY: 1, BINNO: 42 }];
    const file = await fx.importRows(owner, 'Team.xlsx', rows);
    const keep = await fx.importRows(owner, 'Keep.xlsx', rows);
    await fx.call(owner, 'open', { fileId: file.fileId });
    const copy = await fx.call(driver, 'open', { fileId: file.fileId });
    await fx.call(driver, 'save', { fileId: file.fileId, copyRevision: copy.copyRevision, edits: [{ index: 0, values: { del_qty: 1, del_status: '' } }] });
    fx.objects.set('excel-files/_cart-delivery-tab.json', Buffer.from(JSON.stringify(['Team.xlsx', 'Keep.xlsx'])));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const errors = []; let deleteCalls = 0, loseResponse = false, release, delay = false;
    const create = async width => {
      const context = await browser.newContext({ viewport: { width, height: 956 }, hasTouch: width === 440, serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.includes('/auth/v1/')) {
            if (url.pathname.endsWith('/token')) return json({ access_token: 'test-token', token_type: 'bearer', refresh_token: 'test-refresh', expires_in: 3600, user: { ...driver, aud: 'authenticated', role: 'authenticated' } });
            if (url.pathname.endsWith('/user')) return json(driver);
            return json({});
          }
          if (url.pathname.includes('/functions/v1/profile-workbooks')) {
            const body = request.postDataJSON();
            if (body.action === 'delete-team-file') {
              deleteCalls++;
              if (delay) await new Promise(resolve => { release = resolve; });
            }
            try {
              const result = await fx.handle(body, request.headers().authorization ? driver : null);
              if (body.action === 'delete-team-file' && loseResponse) { loseResponse = false; return route.abort(); }
              return json(result);
            } catch (error) { return json({ error: error.message }, 400); }
          }
          if (url.pathname.includes('_cart-delivery-tab.json')) return json(JSON.parse(Buffer.from(fx.objects.get('excel-files/_cart-delivery-tab.json')).toString()));
          if (url.pathname.includes('/storage/v1/object/list/excel-files')) return json([...fx.objects.keys()].filter(key => key.startsWith('excel-files/') && /xlsx$/.test(key)).map(key => ({ name: key.slice(12), id: key })));
          return json([]);
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      return page;
    };
    const phone = await create(440), desktop = await create(1440);
    const openFiles = async page => {
      await page.evaluate(() => document.getElementById('openFileManagerBtn').click());
      await page.locator('.saved-file-card').first().waitFor();
    };
    const card = (page, name) => page.locator('.saved-file-card').filter({ has: page.locator('.saved-file-name', { hasText: name }) });
    for (const page of [phone, desktop]) {
      await openFiles(page);
      assert.equal(await page.locator('.saved-file-delete-btn').count(), 0, 'Guests have no delete action');
      await page.evaluate(async () => { await sb.auth.signInWithPassword({ email: 'any_driver@profiles.cartdelivery.invalid', password: 'test-password' }); });
      await page.waitForFunction(() => profileState.user !== null);
      await page.evaluate(() => listFiles());
      assert.equal(await page.locator('.saved-file-delete-btn').count(), 2);
      await page.locator('#allSavedFilesTab').click();
      await page.getByRole('button', { name: 'Add to Cart Delivery', exact: true }).count();
      await page.waitForFunction(() => !document.querySelector('.saved-file-delete-btn'));
      await page.locator('#cartDeliveryFilesTab').click();
      await card(page, 'Team.xlsx').getByRole('button', { name: 'Delete team Excel for everyone' }).waitFor();
      await page.evaluate(file => openProfileFile(file), file);
      assert.equal(await page.evaluate(() => profileState.workspace.pending), 1);
      await openFiles(page);
      await card(page, 'Team.xlsx').getByRole('button', { name: 'Delete team Excel for everyone' }).click();
      await page.waitForFunction(() => teamFileDeletion?.preview && !teamFileDeletion.busy);
      assert.match(await page.locator('#deleteTeamFileSummary').textContent(), /2 profile copies.*1 unsynced/);
      assert(await page.locator('#confirmDeleteTeamFileBtn').isDisabled());
      await page.locator('#deleteTeamFileConfirm').fill('Wrong.xlsx');
      await page.locator('#deleteTeamFileAcknowledged').check();
      assert(await page.locator('#confirmDeleteTeamFileBtn').isDisabled());
      await page.locator('#deleteTeamFileConfirm').fill('Team.xlsx');
      assert(await page.locator('#confirmDeleteTeamFileBtn').isDisabled(), 'The filename is no longer the confirmation word');
      await page.locator('#deleteTeamFileConfirm').fill('confirm');
      assert(await page.locator('#confirmDeleteTeamFileBtn').isDisabled(), 'The label specifies Confirm with a capital C');
      await page.locator('#deleteTeamFileConfirm').fill('Confirm');
      assert(await page.locator('#confirmDeleteTeamFileBtn').isEnabled());
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        assert(await page.locator('#deleteTeamFileDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        for (const id of ['cancelDeleteTeamFileBtn', 'confirmDeleteTeamFileBtn']) {
          const box = await page.locator('#' + id).boundingBox();
          assert(box.height >= 44); assert(box.y >= 0 && box.y + box.height <= 956);
        }
        await page.screenshot({ path: path.join(root, `local-artifacts/delete-${page.viewportSize().width}-${light ? 'light' : 'dark'}.png`) });
      }
      if (page === phone) {
        await page.setViewportSize({ width: 440, height: 600 });
        await page.waitForFunction(() => {
          const box = document.getElementById('confirmDeleteTeamFileBtn').getBoundingClientRect();
          return box.y >= 0 && box.bottom <= innerHeight;
        });
        const box = await page.locator('#confirmDeleteTeamFileBtn').boundingBox();
        assert(box.y >= 0 && box.y + box.height <= 600, 'Confirmation remains reachable with a short phone viewport');
        assert(await page.locator('#deleteTeamFileDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        await page.setViewportSize({ width: 440, height: 956 });
      }
      await page.locator('#cancelDeleteTeamFileBtn').click();
    }
    assert.equal(deleteCalls, 0, 'Cancel and preview never delete');
    assert.equal((await fx.call(driver, 'open', { fileId: file.fileId })).pending, 1);
    await card(phone, 'Team.xlsx').getByRole('button', { name: 'Delete team Excel for everyone' }).click();
    await phone.waitForFunction(() => teamFileDeletion?.preview && !teamFileDeletion.busy);
    await phone.locator('#deleteTeamFileConfirm').fill('Confirm');
    await phone.locator('#deleteTeamFileAcknowledged').check();
    fx.state.failRemove = true; delay = true;
    await phone.locator('#confirmDeleteTeamFileBtn').click();
    await phone.waitForFunction(() => teamFileDeletion?.busy);
    assert(await phone.locator('#cancelDeleteTeamFileBtn').isDisabled());
    assert(await phone.locator('#confirmDeleteTeamFileBtn').isDisabled());
    await phone.keyboard.press('Escape'); assert(await phone.locator('#deleteTeamFileDialog').isVisible());
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    delay = false; release();
    await phone.getByText('Stored file cleanup is not complete.', { exact: false }).waitFor();
    assert.equal(deleteCalls, 1);
    assert.equal(await phone.evaluate(() => profileState.workspace), null);
    assert.equal(await phone.evaluate(() => window._currentRows), null);
    assert.equal(await phone.evaluate(() => Object.keys(routeDayGroups).length), 0);
    assert.equal(await phone.evaluate(() => localStorage.getItem(`cartdelivery.resume.${profileState.user.id}`)), null);
    await phone.locator('#cancelDeleteTeamFileBtn').click();
    await card(phone, 'Team.xlsx').getByRole('button', { name: 'Finish deletion' }).waitFor();
    await desktop.evaluate(() => window.dispatchEvent(new Event('focus')));
    await desktop.waitForFunction(() => profileState.workspace === null);
    await desktop.evaluate(() => listFiles());
    await card(desktop, 'Team.xlsx').getByRole('button', { name: 'Finish deletion' }).click();
    await desktop.waitForFunction(() => teamFileDeletion?.preview && !teamFileDeletion.busy);
    await desktop.locator('#deleteTeamFileConfirm').fill('Confirm');
    await desktop.locator('#deleteTeamFileAcknowledged').check();
    fx.state.failRemove = false; loseResponse = true;
    await desktop.locator('#confirmDeleteTeamFileBtn').click();
    await desktop.locator('#deleteTeamFileDialog').waitFor({ state: 'hidden' });
    await desktop.waitForFunction(() => !profileState.busy);
    assert.equal(await card(desktop, 'Team.xlsx').count(), 0);
    assert.equal(await card(desktop, 'Keep.xlsx').count(), 1);
    assert.equal(deleteCalls, 3, 'Lost deletion response retries the same target safely');
    assert(fx.objects.has('excel-files/Keep.xlsx'));
    assert.equal((await fx.call(driver, 'original', { fileId: keep.fileId })).rowCount, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: phone/desktop and both themes; guest gating, Confirm keyword and acknowledgement, cancel, busy/escape protection, all-copy deletion, current/remote map reset, cleanup retry and lost response recovery.');
  } finally { await browser?.close(); server.close(); await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
