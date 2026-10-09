const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./profile-workbooks.fixture.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  const fx = await fixture();
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const accounts = new Map(), tokens = new Map(), errors = [];
    let delaySave, releaseSave, loseSyncResponse = false;
    const create = async width => {
      const context = await browser.newContext({ viewport: { width, height: 956 }, hasTouch: width === 440, serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (url.hostname === 'fixture.invalid') {
          const bytes = fx.objects.get(url.pathname.slice(1));
          return route.fulfill({ status: bytes ? 200 : 404, contentType: 'application/octet-stream', body: bytes ? Buffer.from(bytes) : '' });
        }
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.includes('/auth/v1/')) {
            const body = request.postDataJSON() || {};
            if (url.pathname.endsWith('/logout')) return json({});
            if (/\/(signup|token)$/.test(url.pathname)) {
              let user = accounts.get(body.email);
              if (url.pathname.endsWith('/signup')) {
                if (user) return json({ msg: 'User already registered' }, 422);
                user = await fx.actor(body.email.split('@')[0]); user.password = body.password; accounts.set(body.email, user);
              }
              if (!user || body.password !== user.password) return json({ msg: 'Invalid login credentials' }, 400);
              const token = Buffer.from(JSON.stringify({ sub: user.id })).toString('base64url'); tokens.set(token, user);
              return json({ access_token: token, token_type: 'bearer', refresh_token: 'fake-refresh-' + user.id, expires_in: 3600, user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' } });
            }
            return json({});
          }
          if (url.pathname.includes('/functions/v1/profile-workbooks')) {
            const body = request.postDataJSON();
            const user = tokens.get(request.headers().authorization?.replace('Bearer ', ''));
            if (body.action === 'save' && delaySave) await new Promise(resolve => { releaseSave = resolve; });
            try {
              const result = await fx.handle(body, user);
              if (body.action === 'sync' && loseSyncResponse) { loseSyncResponse = false; return route.abort(); }
              return json(result);
            } catch (error) { return json({ error: error.message }, error.message.includes('STALE') ? 409 : 400); }
          }
          if (url.pathname.includes('_cart-delivery-tab.json')) return json(['Trash.xlsx']);
          return json([]);
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      return page;
    };
    const a = await create(440), b = await create(1440);
    const signup = async (page, username) => {
      await page.locator('#profileWorkspaceBtn').click();
      await page.locator('#profileUsername').fill(username); await page.locator('#profilePassword').fill('test-password');
      await page.locator('#createProfileBtn').click();
      await page.waitForFunction(() => profileState.user !== null && !profileState.busy);
      assert.equal(await page.locator('#profileAccountName').textContent(), username.toLowerCase());
    };
    await signup(a, 'Team_A'); await signup(b, 'team_b');
    const rows = [0, 1, 2].map(index => ({ ID: index, QTY: 3, ROUTE: 'A', DAY: 1, 'CSADR#': 100 + index, CSSTRT: 'Test', BINNO: `00${index}`, LATITUDE: 30.75 + index * .001, LONGITUDE: -98.23, del_qty: 0, del_status: '' }));
    const imported = await fx.call(accounts.get('team_a@profiles.cartdelivery.invalid'), 'import', { name: 'Trash.xlsx', base64: Buffer.from(fx.workbook(rows)).toString('base64') });
    const openCopy = async page => {
      await page.locator('#profileChooseFileBtn').click(); await page.locator('.saved-file-btn').click();
      await page.waitForFunction(() => profileState.workspace?.mode === 'copy' && !profileState.busy);
    };
    await openCopy(a); await openCopy(b);
    const select = (page, ids) => page.evaluate(ids => {
      individuallySelectedMarkers.clear();
      Object.values(routeDayGroups).flatMap(group => group.layers).filter(marker => ids.includes(marker._rowRef.ID)).forEach(marker => individuallySelectedMarkers.add(marker));
      updateSelectionCount(); updateUndoButtonState();
    }, ids);
    const deliver = async (page, ids) => { await select(page, ids); await page.locator(page === a ? '#completeStopsBtnMobile' : '#completeStopsBtn').click(); };
    delaySave = true;
    await deliver(a, [0, 2]);
    await a.waitForFunction(() => deliverySaveInProgress);
    assert.deepEqual(await a.evaluate(() => _currentRows.map(row => row.del_qty)), [0, 0, 0]);
    while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 10));
    delaySave = false; releaseSave();
    await a.waitForFunction(() => !deliverySaveInProgress && _currentRows[0].del_qty === 1);
    await deliver(b, [1, 2]); await b.waitForFunction(() => !deliverySaveInProgress && _currentRows[1].del_qty === 1);
    assert.deepEqual((await fx.pg.query('select rows from cd_files')).rows[0].rows.map(row => row.del_qty), [0, 0, 0]);
    const review = async page => { await page.locator('#profileWorkspaceBtn').click(); await page.locator('#profileReviewBtn').click(); await page.waitForFunction(() => profileState.preview !== null && !profileState.busy); };
    await review(a); loseSyncResponse = true;
    await a.locator('#confirmProfileSyncBtn').click();
    await a.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_syncs')).rows[0].n, 1, 'Lost response retry syncs once');
    await review(b);
    assert.equal(await b.locator('[data-conflict-index]').count(), 1);
    await b.locator('#confirmProfileSyncBtn').click();
    await b.waitForFunction(() => !profileState.busy);
    assert.match(await b.locator('#profileSyncStatus').textContent(), /every overlapping/);
    await b.locator('[data-conflict-index="2"]').selectOption('count');
    await b.locator('[data-conflict-count="2"]').fill('2');
    for (const width of [440, 1440]) {
      await b.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await b.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await b.screenshot({ path: path.join(root, `local-artifacts/profiles-sync-${width}-${light ? 'light' : 'dark'}.png`) });
        assert(await b.locator('#profileSyncDialog').evaluate(el => el.scrollWidth <= el.clientWidth), 'No horizontal dialog overflow');
        assert(await b.locator('#confirmProfileSyncBtn').evaluate(el => el.getBoundingClientRect().height >= 44));
      }
    }
    await b.locator('#confirmProfileSyncBtn').click();
    await b.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    assert.deepEqual(await b.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 1, 2]);
    await b.locator('#profileHistoryBtn').click(); await b.waitForFunction(() => !profileState.busy);
    assert.equal(await b.locator('#profileHistoryEntries details').count(), 2);
    assert.match(await b.locator('#profileHistoryEntries').textContent(), /team_a/);
    assert.match(await b.locator('#profileHistoryEntries').textContent(), /team_b/);
    await b.locator('#profileHistoryEntries details').first().locator('summary').click();
    await b.screenshot({ path: path.join(root, 'local-artifacts/profiles-history.png') });
    await b.locator('#closeProfileHistoryBtn').click();
    await b.locator('#profileWorkspaceBtn').click(); await b.locator('#profileChooseFileBtn').click();
    await b.getByRole('button', { name: 'View original', exact: true }).click();
    await b.waitForFunction(() => profileState.workspace?.mode === 'original' && !profileState.busy);
    await select(b, [0]); assert.equal(await b.locator('#recordCartsBtn').isDisabled(), true);
    await b.locator('#profileWorkspaceBtn').click(); await b.locator('#signOutProfileBtn').click();
    await b.waitForFunction(() => !profileState.user && !profileState.busy);
    assert.equal(await b.evaluate(() => _currentWorkbook), null);
    await b.locator('#profileUsername').fill('TEAM_A'); await b.locator('#profilePassword').fill('test-password');
    await b.locator('#createProfileBtn').click(); await b.waitForFunction(() => !profileState.busy);
    assert.match(await b.locator('#profileStatus').textContent(), /already exists/);
    await b.locator('#profileAuthForm button[type="submit"]').click();
    await b.waitForFunction(() => profileState.user !== null && !profileState.busy);
    await openCopy(b);
    assert.deepEqual(await b.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 0, 1], 'Reopen same profile snapshot across devices');
    assert.deepEqual(errors, []);
    console.log('PASS: two profiles end to end, username uniqueness/sign-in, delayed saves, explicit sync, overlap review, lost-response retry, history, original read-only, cross-device resume, phone/desktop themes. No live storage.');
  } finally { if (browser) await browser.close(); await fx.pg.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
