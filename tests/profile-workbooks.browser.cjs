const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./profile-data.fixture.cjs');
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
    let delaySave, releaseSave, loseSyncResponse = false, loseImportBatchResponse = true, failImport = true, failedImportRequests = 0;
    let sourceDownloads = 0;
    let syncRequests = 0;
    let oldPublicApi = false, missingSharedList = false, shortcutWrites = 0;
    let sharedNames = ['Trash.xlsx'], failShortcutWrite = false;
    const dialogs = [];
    const create = async width => {
      const context = await browser.newContext({ viewport: { width, height: 956 }, hasTouch: width === 440, serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (url.hostname === 'fixture.invalid') {
          sourceDownloads++;
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
            if (oldPublicApi && body.action.startsWith('public-')) return json({ error: 'SIGN_IN_REQUIRED' }, 401);
            if (body.action === 'sync') syncRequests++;
            const user = tokens.get(request.headers().authorization?.replace('Bearer ', ''));
            if (body.action === 'import-start' && failImport) {
              failedImportRequests++;
              return json({ code: 'WORKER_LIMIT', message: 'Worker resource limit reached' }, 546);
            }
            if (body.action === 'save' && delaySave) await new Promise(resolve => { releaseSave = resolve; });
            try {
              const result = await fx.handle(body, user);
              if (body.action === 'import-batch' && loseImportBatchResponse) { loseImportBatchResponse = false; return route.abort(); }
              if (body.action === 'sync' && loseSyncResponse) { loseSyncResponse = false; return route.abort(); }
              return json(result);
            } catch (error) { return json({ error: error.message }, error.message.includes('STALE') ? 409 : 400); }
          }
          if (url.pathname.includes('_cart-delivery-tab.json')) {
            if (request.method() !== 'GET') {
              shortcutWrites++;
              if (failShortcutWrite) return json({ message: 'Simulated list save failure' }, 500);
              const type = request.headers()['content-type'];
              if (type.startsWith('multipart/')) {
                const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': type } }).formData();
                sharedNames = JSON.parse(await form.get('').text());
              } else sharedNames = JSON.parse(request.postData());
              return json({ Key: 'excel-files/_cart-delivery-tab.json' });
            }
            return missingSharedList ? json({ error: 'Not found' }, 404) : json(sharedNames);
          }
          if (url.pathname.includes('/storage/v1/object/public/excel-files/')) {
            const bytes = fx.objects.get('excel-files/' + decodeURIComponent(url.pathname.split('/excel-files/')[1]));
            return route.fulfill({ status: bytes ? 200 : 404, contentType: 'application/octet-stream', body: bytes ? Buffer.from(bytes) : '' });
          }
          if (url.pathname.includes('/storage/v1/object/upload/sign/')) {
            const key = decodeURIComponent(url.pathname.split('/storage/v1/object/upload/sign/')[1]);
            const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
            const file = form.get('');
            const [bucket, ...parts] = key.split('/');
            const result = await fx.db.storage.from(bucket).upload(parts.join('/'), new Uint8Array(await file.arrayBuffer()), { upsert: false });
            return result.error ? json({ message: result.error.message }, 400) : json({ Key: key });
          }
          if (url.pathname.includes('/storage/v1/object/list/excel-files')) return json([{ name: 'Trash.xlsx', id: 'legacy-fixture', metadata: { size: 1000 } }]);
          return json([]);
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.accept(); });
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      return page;
    };
    const a = await create(440), b = await create(1440);
    for (const width of [360, 440]) {
      await a.setViewportSize({ width, height: 956 });
      for (let theme = 0; theme < 2; theme++) {
        await a.locator('.header-top .theme-toggle').click();
        assert.equal(await a.locator('#sunModeToggle').isChecked(), await a.locator('body').evaluate(el => el.classList.contains('sun-mode')));
        assert.equal(await a.locator('.header-workspace').isVisible(), false, 'An empty phone workspace adds no header row');
        assert.equal(await a.locator('#profileWorkspaceBtn').evaluate(el => el.parentElement.className), 'header-top');
        for (const target of ['#downloadFullExcelBtn', '.theme-toggle', '#lockScreenBtn', '#profileWorkspaceBtn']) {
          assert(await a.locator(target).evaluate(el => el.getBoundingClientRect().height >= 44));
        }
        assert(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await a.locator('header').screenshot({ path: path.join(root, `local-artifacts/header-empty-${width}-${theme}.png`) });
      }
    }
    await a.setViewportSize({ width: 440, height: 956 });
    const captureProfile = async (page, name, selector = '#profileDialog') => {
      for (const light of [false, true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await page.screenshot({ path: path.join(root, `local-artifacts/profile-ui-${name}-${page.viewportSize().width}-${light ? 'light' : 'dark'}.png`) });
        assert(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth), 'Profile screens fit without horizontal scrolling');
        for (const button of await page.locator(`${selector} button:visible`).all()) {
          assert(await button.evaluate(el => el.getBoundingClientRect().height >= 44), 'Profile tap targets are at least 44px');
        }
      }
    };
    for (const page of [a, b]) {
      await page.locator('#profileWorkspaceBtn').click();
      await captureProfile(page, 'signin');
      await page.locator('#closeProfileBtn').click();
    }
    const signup = async (page, username) => {
      await page.locator('#profileWorkspaceBtn').click();
      assert.equal(await page.locator('#profileSignInBtn').isVisible(), true);
      await page.locator('#profileCreateMode').click();
      assert.equal(await page.locator('#profilePassword').getAttribute('autocomplete'), 'new-password');
      await page.locator('#profileUsername').fill(username); await page.locator('#profilePassword').fill('test-password');
      await page.locator('#profileShowPassword').click();
      assert.equal(await page.locator('#profilePassword').getAttribute('type'), 'text');
      await page.locator('#profileShowPassword').click();
      await page.locator('#createProfileBtn').click();
      await page.waitForFunction(() => profileState.user !== null && !profileState.busy);
      assert.equal(await page.locator('#profileAccountName').textContent(), username.toLowerCase());
      assert.equal(await page.locator('#profileReviewBtn').isVisible(), false, 'No irrelevant sharing controls before a file is open');
    };
    await signup(a, 'Team_A'); await signup(b, 'team_b');
    await captureProfile(a, 'choose-file');
    const rows = [0, 1, 2].map(index => ({ ID: index, QTY: 3, ROUTE: 'A', DAY: 1, 'CSADR#': 100 + index, CSSTRT: 'Test', BINNO: `00${index}`, LATITUDE: 30.75 + index * .001, LONGITUDE: -98.23, del_qty: 0, del_status: '' }));
    fx.objects.set('excel-files/Trash.xlsx', fx.workbook(rows));
    const guest = await create(440);
    oldPublicApi = true;
    await guest.evaluate(() => document.getElementById('openFileManagerBtn').click());
    await guest.getByText('Team viewing needs a server update.', { exact: false }).waitFor();
    assert.equal(await guest.locator('.saved-file-card').count(), 0, 'An outdated backend never falls back to potentially stale source data');
    await guest.locator('#closeFileManager').click();
    oldPublicApi = false;
    missingSharedList = true;
    await guest.evaluate(() => { cartDeliveryFileNames = new Set(['Trash.xlsx']); });
    const openGuestFile = async () => {
      await guest.evaluate(() => document.getElementById('openFileManagerBtn').click());
      await guest.locator('.saved-file-btn').click();
      await guest.waitForFunction(() => profileState.workspace?.mode === 'original' && !profileState.busy);
    };
    await openGuestFile();
    assert.equal(shortcutWrites, 0, 'Guest viewing never seeds or changes the shared shortlist');
    missingSharedList = false;
    assert.equal(await guest.evaluate(() => profileState.user), null);
    assert.equal(await guest.evaluate(() => profileState.workspace.legacy), true);
    assert.equal(await guest.locator('#recordCartsBtn').isDisabled(), true);
    assert.match(await guest.locator('#routeContext').textContent(), /TEAM EXCEL · VIEW ONLY/);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_files')).rows[0].n, 0, 'Anonymous source viewing does not import or create copies');
    await a.locator('#profileChooseFileBtn').click();
    await a.locator('.saved-file-btn').waitFor();
    await captureProfile(a, 'files', '#fileManagerModal .modal-content');
    await a.locator('.saved-file-btn').click();
    await a.waitForFunction(() => !profileState.busy);
    assert.equal(failedImportRequests, 1, 'A resource-limit response is not automatically retried');
    assert.match(dialogs.pop(), /server ran out of resources/i);
    assert.equal(await a.evaluate(() => profileState.workspace), null);
    assert.equal(await a.locator('#loadingOverlay').isVisible(), false);
    assert.equal(fx.state.uploads.length, 0);
    failImport = false;
    await a.locator('.saved-file-btn').click();
    await a.waitForFunction(() => profileState.workspace?.mode === 'copy' && !profileState.busy);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_files where ready')).rows[0].n, 1);
    const openCopy = async page => {
      await page.locator('#profileChooseFileBtn').click(); await page.locator('.saved-file-btn').click();
      await page.waitForFunction(() => profileState.workspace?.mode === 'copy' && !profileState.busy);
    };
    await openCopy(b);
    const select = (page, ids) => page.evaluate(ids => {
      individuallySelectedMarkers.clear();
      Object.values(routeDayGroups).flatMap(group => group.layers).filter(marker => ids.includes(marker._rowRef.ID)).forEach(marker => individuallySelectedMarkers.add(marker));
      updateSelectionCount(); updateUndoButtonState();
    }, ids);
    const deliver = async (page, ids) => { await select(page, ids); await page.locator(page === a ? '#completeStopsBtnMobile' : '#completeStopsBtn').click(); };
    delaySave = true;
    await deliver(a, [0, 2]);
    await a.waitForFunction(() => deliverySaveInProgress);
    assert.match(await a.locator('#routeContext').textContent(), /Saving to my copy/);
    assert.deepEqual(await a.evaluate(() => _currentRows.map(row => row.del_qty)), [0, 0, 0]);
    while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 10));
    delaySave = false; releaseSave();
    await a.waitForFunction(() => !deliverySaveInProgress && _currentRows[0].del_qty === 1);
    assert.match(await a.locator('#routeContext').textContent(), /2 stops waiting to sync/);
    await deliver(b, [1, 2]); await b.waitForFunction(() => !deliverySaveInProgress && _currentRows[1].del_qty === 1);
    await deliver(b, [2]); await b.waitForFunction(() => !deliverySaveInProgress && _currentRows[2].del_qty === 2);
    await a.locator('#profileWorkspaceBtn').click();
    assert.match(await a.locator('#profileSaveSummary').textContent(), /saved in your copy/);
    await captureProfile(a, 'saved-work');
    await a.locator('#profileContinueBtn').click();
    assert.equal(await a.locator('#profileDialog').isVisible(), false);
    assert.deepEqual((await fx.read(accounts.get('team_a@profiles.cartdelivery.invalid'), await a.evaluate(() => profileState.workspace.fileId), 'original')).map(row => row.del_qty), [0, 0, 0]);
    const review = async page => { await page.locator('#profileWorkspaceBtn').click(); await page.locator('#profileReviewBtn').click(); await page.waitForFunction(() => profileState.preview !== null && !profileState.busy); };
    await review(a); loseSyncResponse = true;
    assert.equal(await a.locator('#profileSyncDetails').getAttribute('open'), null);
    assert.equal(await a.locator('#profileSyncChanges .profile-change').count(), 0, 'Routine changes are not rendered until requested');
    assert.deepEqual(await a.locator('#profileSyncImpact dd').allTextContents(), ['2', '2', '0', '0']);
    await a.locator('#profileSyncDetails summary').click();
    await a.locator('#profileSyncDetails .profile-change').first().waitFor();
    assert.equal(await a.locator('#profileSyncDetails .profile-change').count(), 2);
    await a.locator('#profileSyncDetails summary').click();
    await a.locator('#confirmProfileSyncBtn').click();
    assert.equal(syncRequests, 0, 'Review Next never sends a sync');
    assert.equal(await a.locator('#profileShareFile').textContent(), 'Trash.xlsx');
    assert.equal(await a.locator('#profileShareAccount').textContent(), 'team_a');
    assert.equal(await a.locator('#commitProfileShareBtn').isDisabled(), true);
    await a.evaluate(() => commitProfileShare());
    assert.equal(syncRequests, 0, 'Commit handler refuses an unchecked acknowledgement');
    await a.locator('#profileShareAcknowledged').check();
    await a.locator('#cancelProfileShareBtn').click();
    assert.equal(syncRequests, 0, 'Backing out with a checked acknowledgement sends nothing');
    assert.equal(await a.locator('#profileSyncDialog').isVisible(), true);
    await a.locator('#confirmProfileSyncBtn').click();
    assert.equal(await a.locator('#profileShareAcknowledged').isChecked(), false, 'Every final check starts unchecked');
    await captureProfile(a, 'final-check', '#profileShareDialog');
    await a.keyboard.press('Escape');
    assert.equal(syncRequests, 0, 'Escape cancels without sharing');
    await a.locator('#confirmProfileSyncBtn').click();
    await a.locator('#profileShareAcknowledged').check();
    await a.evaluate(() => { document.getElementById('commitProfileShareBtn').click(); document.getElementById('commitProfileShareBtn').click(); });
    await a.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    assert.match(await a.locator('#profileLastSync').textContent(), /Last sync:/);
    assert.match(await a.locator('#routeContext').textContent(), /Nothing waiting to sync/);
    assert.equal(syncRequests, 2, 'Only the initial request and its lost-response retry are sent');
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_history')).rows[0].n, 1, 'Lost response retry syncs once');
    await review(b);
    assert.equal(await b.locator('[data-conflict-index]').count(), 1);
    assert.deepEqual(await b.locator('#profileSyncImpact dd').allTextContents(), ['1', '1', '0', '0']);
    assert.match(await b.locator('#profileSyncImpact').textContent(), /1 conflicts still need a decision/);
    await b.locator('#confirmProfileSyncBtn').click();
    await b.waitForFunction(() => !profileState.busy);
    assert.match(await b.locator('#profileSyncStatus').textContent(), /every highlighted stop/);
    assert.equal(await b.locator('#profileShareDialog').isVisible(), false, 'Conflicts block the final check');
    await b.locator('[data-conflict-index="2"]').selectOption('count');
    await b.locator('[data-conflict-count="2"]').fill('2');
    assert.deepEqual(await b.locator('#profileSyncImpact dd').allTextContents(), ['2', '2', '0', '0'], 'Conflict totals compare against the latest team counts');
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
    await captureProfile(b, 'final-check', '#profileShareDialog');
    await b.locator('#profileShareAcknowledged').check();
    await b.locator('#commitProfileShareBtn').click();
    await b.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    assert.deepEqual(await b.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 1, 2]);
    const copiesBeforeGuest = (await fx.pg.query('select count(*)::int n from cd_data_copies')).rows[0].n;
    await openGuestFile();
    assert.deepEqual(await guest.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 1, 2], 'Anonymous database view includes current shared deliveries');
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_copies')).rows[0].n, copiesBeforeGuest);
    for (const width of [440, 1440]) {
      await guest.setViewportSize({ width, height: 956 });
      await guest.screenshot({ path: path.join(root, `local-artifacts/team-view-${width}.png`) });
      assert(await guest.locator('#routeContext').isVisible());
      assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Team banner fits the viewport');
      await guest.locator('#profileWorkspaceBtn').click();
      assert.match(await guest.locator('#profileDialog .route-context').textContent(), /TEAM EXCEL · VIEW ONLY/);
      await guest.locator('#closeProfileBtn').click();
    }
    const exported = await b.evaluate(async () => {
      const workbook = await profileExportWorkbook();
      return { rows: XLSX.utils.sheet_to_json(workbook.Sheets.Stops), formula: workbook.Sheets['Keep formula'].A1.f };
    });
    assert.deepEqual(exported.rows.map(row => row.del_qty), [1, 1, 2]);
    assert.equal(exported.formula, '1+2');
    assert.equal(fx.state.uploads.length, 0, 'Importing legacy data, opening, saving and syncing never uploads a workbook');
    await b.locator('#profileHistoryBtn').click(); await b.waitForFunction(() => !profileState.busy);
    assert.equal(await b.locator('#profileHistoryEntries details').count(), 2);
    assert.match(await b.locator('#profileHistoryEntries').textContent(), /team_a/);
    assert.match(await b.locator('#profileHistoryEntries').textContent(), /team_b/);
    await b.locator('#profileHistoryEntries details').first().locator('summary').click();
    await b.waitForFunction(() => document.querySelector('#profileHistoryEntries details[open]')?.textContent.includes('Carts delivered'));
    await b.screenshot({ path: path.join(root, 'local-artifacts/profiles-history.png') });
    await b.locator('#closeProfileHistoryBtn').click();
    assert.equal(await b.locator('#profileDialog').isVisible(), true, 'History Back returns to profile');
    await b.locator('#profileChooseFileBtn').click();
    await b.getByRole('button', { name: 'View team Excel (read only)', exact: true }).click();
    await b.waitForFunction(() => profileState.workspace?.mode === 'original' && !profileState.busy);
    await select(b, [0]); assert.equal(await b.locator('#recordCartsBtn').isDisabled(), true);
    await b.locator('#profileWorkspaceBtn').click(); await b.locator('#signOutProfileBtn').click();
    await b.waitForFunction(() => !profileState.user && !profileState.busy);
    assert.equal(await b.evaluate(() => profileState.workspace.mode), 'original', 'Public team view remains visible after signing out');
    assert.equal(await b.locator('#recordCartsBtn').isDisabled(), true);
    assert.equal(await b.locator('#profileSignInBtn').isVisible(), true);
    await b.locator('#profileCreateMode').click();
    await b.locator('#profileUsername').fill('TEAM_A'); await b.locator('#profilePassword').fill('test-password');
    await b.locator('#createProfileBtn').click(); await b.waitForFunction(() => !profileState.busy);
    assert.match(await b.locator('#profileStatus').textContent(), /already exists/);
    await b.locator('#profileSignInMode').click();
    await b.locator('#profileSignInBtn').click();
    await b.waitForFunction(() => profileState.user !== null && !profileState.busy);
    await openCopy(b);
    assert.deepEqual(await b.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 0, 1], 'Reopen same profile snapshot across devices');
    await review(b);
    assert.equal(await b.locator('#profileSyncChanges').isVisible(), false);
    assert.match(await b.locator('#confirmProfileSyncBtn').textContent(), /confirm copy update/);
    await b.locator('#confirmProfileSyncBtn').click();
    assert.match(await b.locator('#profileShareEffect').textContent(), /no changes to send/);
    await b.locator('#cancelProfileShareBtn').click();
    await b.locator('#closeProfileSyncBtn').click();
    assert.equal(await b.locator('#profileDialog').isVisible(), true, 'Review Back returns to profile without sharing');
    await b.locator('#profileContinueBtn').click();
    const bigRows = Array.from({ length: 5364 }, (_, index) => ({ ID:index,QTY:3,ROUTE:'A',DAY:1,
      ...Object.fromEntries(Array.from({length:32},(_,col)=>['FIELD_'+col,`Sample ${index}-${col}`])) }));
    fx.objects.set('excel-files/Large.xlsx', fx.workbook(bigRows));
    const beforeImportDownloads=sourceDownloads;
    await a.evaluate(() => openProfileFile({name:'Large.xlsx',sourceKey:'Large.xlsx'}));
    assert.equal(await a.evaluate(()=>_currentRows.length),5364,'Phone imports all worker batches');
    const largeFileId=await a.evaluate(()=>profileState.workspace.fileId);
    await b.evaluate(fileId=>openProfileFile({fileId}),largeFileId);
    assert.equal(await b.evaluate(()=>_currentRows.length),5364);
    assert.equal(sourceDownloads,beforeImportDownloads+1,'After first import, phone/desktop opens fetch database rows only');
    assert.equal(fx.state.uploads.length,0);
    const largeCopy = await a.evaluate(() => profileState.workspace);
    await fx.call(accounts.get('team_a@profiles.cartdelivery.invalid'), 'save', {
      fileId: largeFileId, copyRevision: largeCopy.copyRevision,
      edits: Array.from({ length: 903 }, (_, index) => ({ index, values: { del_qty: 1, del_status: '' } }))
    });
    await a.evaluate(fileId => openProfileFile({ fileId }), largeFileId);
    await review(a);
    assert.deepEqual(await a.locator('#profileSyncImpact dd').allTextContents(), ['903', '903', '0', '0'], 'Summary includes every preview page');
    assert.equal(await a.locator('#profileSyncChanges .profile-change').count(), 0, 'A 903-stop sync starts with totals, not hundreds of cards');
    for (const width of [440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      await captureProfile(a, 'sync-summary-903', '#profileSyncDialog');
    }
    await a.setViewportSize({ width: 440, height: 956 });
    await a.locator('#profileSyncDetails summary').click();
    await a.locator('#profileSyncDetails .profile-change').first().waitFor();
    assert.equal(await a.locator('#profileSyncDetails .profile-change').count(), 50, 'Optional details are paginated');
    await a.locator('#profileSyncDetails').getByRole('button', { name: 'Show more stops' }).click();
    assert.equal(await a.locator('#profileSyncDetails .profile-change').count(), 100);
    await a.locator('#closeProfileSyncBtn').click();
    await a.locator('#profileContinueBtn').click();
    const uploadBytes = Buffer.from(fx.workbook(rows));
    const chooseUpload = async (page, name, buffer = uploadBytes) => {
      await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      if (/\.(xlsx|xls|csv)$/i.test(name)) {
        await page.waitForFunction(() => teamUploadState.inspection && !teamUploadState.inspecting && !teamUploadState.checking);
        await page.locator('#teamMappingConfirmed').check();
      }
    };
    await a.evaluate(() => document.getElementById('openFileManagerBtn').click());
    await a.locator('#uploadTeamExcelBtn').click();
    await chooseUpload(a, 'Wrong.pdf', Buffer.from('not Excel'));
    assert.match(await a.locator('#teamUploadStatus').textContent(), /Choose an Excel/);
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), true);
    await chooseUpload(a, 'New.xlsx');
    assert.equal(fx.state.uploads.length, 0, 'Choosing a file sends no upload');
    for (const width of [440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      await captureProfile(a, 'upload-ready', '#teamUploadDialog');
    }
    await a.setViewportSize({ width: 440, height: 956 });
    await a.locator('#closeTeamUploadBtn').click();
    assert.equal(fx.state.uploads.length, 0, 'Cancelling sends no upload');
    await a.evaluate(() => openTeamUpload());
    failShortcutWrite = true;
    await a.locator('#confirmTeamUploadBtn').click();
    await a.waitForFunction(() => !profileState.busy && teamUploadState.result);
    assert.match(await a.locator('#teamUploadStatus').textContent(), /saved, but we could not confirm/);
    assert.deepEqual(sharedNames, ['Trash.xlsx'], 'Failed list save preserves existing shortcuts');
    assert.equal(fx.state.uploads.length, 1);
    failShortcutWrite = false;
    await a.locator('#confirmTeamUploadBtn').click();
    await a.waitForFunction(() => !profileState.busy && teamUploadState.added);
    assert.equal(fx.state.uploads.length, 1, 'Retry never uploads the source again');
    assert.deepEqual(sharedNames, ['Trash.xlsx', 'New.xlsx']);
    await captureProfile(a, 'upload-success', '#teamUploadDialog');
    await a.locator('#viewUploadedFileBtn').click();
    await a.locator('.saved-file-card').filter({ hasText: 'New.xlsx' }).waitFor();
    assert.equal(await a.locator('#cartDeliveryFilesTab').getAttribute('aria-selected'), 'true');
    await a.locator('.saved-file-card').filter({ hasText: 'New.xlsx' }).locator('.saved-file-btn').click();
    await a.waitForFunction(() => !profileState.busy && profileState.workspace?.name === 'New.xlsx');
    await guest.evaluate(() => document.getElementById('openFileManagerBtn').click());
    await guest.locator('.saved-file-card').filter({ hasText: 'New.xlsx' }).waitFor();
    await guest.locator('#uploadTeamExcelBtn').click();
    await chooseUpload(guest, 'Another.xlsx');
    await guest.locator('#confirmTeamUploadBtn').click();
    assert.equal(await guest.locator('#profileDialog').isVisible(), true);
    await guest.locator('#profileUsername').fill('team_a');
    await guest.locator('#profilePassword').fill('test-password');
    await guest.locator('#profileSignInBtn').click();
    await guest.locator('#teamUploadDialog').waitFor();
    assert.equal(await guest.locator('#teamUploadFileName').textContent(), 'Another.xlsx', 'Sign-in keeps the selected file');
    assert.equal(fx.state.uploads.length, 1, 'Sign-in does not automatically upload');
    await guest.locator('#closeTeamUploadBtn').click();
    await a.evaluate(() => openTeamUpload());
    await chooseUpload(a, 'New.xlsx');
    await a.locator('#confirmTeamUploadBtn').click();
    await a.waitForFunction(() => !profileState.busy);
    assert.match(await a.locator('#teamUploadStatus').textContent(), /name already exists/);
    assert.equal(fx.state.uploads.length, 1, 'Duplicate names never overwrite originals');
    await a.locator('#closeTeamUploadBtn').click();
    assert.deepEqual(await a.evaluate(()=>_currentRows.map(row=>row.del_qty)),[0,0,0]);
    const mappedBytes = Buffer.from(fx.workbook([{ Lat: 30.75, Lng: -98.23, 'Route name': 'Mapped', 'Service day': 'Tuesday',
      'Cart quantity': 3, Address: '123 Main St', 'Cart ID': '0012', 'Delivered qty': 0, 'Delivery status': '', Notes: 'Gate', Alternative: 2 }]));
    await a.evaluate(() => openTeamUpload());
    await chooseUpload(a, 'Mapped.xlsx', mappedBytes);
    assert.equal(await a.locator('[data-mapping-field="QTY"]').inputValue(), 'Cart quantity');
    assert.equal(await a.locator('[data-mapping-field="LATITUDE"]').inputValue(), 'Lat');
    await a.locator('[data-mapping-field="QTY"]').selectOption('Alternative');
    assert.equal(await a.locator('#teamMappingConfirmed').isChecked(), false);
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), true);
    assert.match(await a.locator('[id="team-sample-QTY"]').textContent(), /2/);
    await a.locator('[data-mapping-field="LONGITUDE"]').selectOption('Lat');
    assert.match(await a.locator('#teamMappingErrors').textContent(), /assigned more than once/);
    await a.locator('[data-mapping-field="LONGITUDE"]').selectOption('Lng');
    for (const width of [440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      await a.locator('#teamUploadDialog').evaluate(el => { el.scrollTop = 0; });
      await captureProfile(a, 'mapping', '#teamUploadDialog');
    }
    await a.setViewportSize({ width: 440, height: 956 });
    await a.locator('#teamMappingConfirmed').check();
    await a.locator('#confirmTeamUploadBtn').click();
    await a.waitForFunction(() => !profileState.busy && teamUploadState.added);
    await a.locator('#openUploadedCopyBtn').click();
    await a.waitForFunction(() => !profileState.busy && profileState.workspace?.name === 'Mapped.xlsx');
    const mappedId = await a.evaluate(() => profileState.workspace.fileId);
    await b.evaluate(fileId => openProfileFile({ fileId }), mappedId);
    assert.deepEqual(await b.evaluate(() => [_currentRows[0].QTY, rowRoute(_currentRows[0]), rowDay(_currentRows[0]), _currentRows[0].BINNO]), [2, 'Mapped', 2, '0012']);
    await b.evaluate(async () => {
      const changes = _currentRows.map(row => ({ ...row, del_qty: 1, del_status: '', delivery_notes: 'Updated' }));
      await saveProfileWorkbook(changes, _currentWorkbook, () => {});
      _currentRows = changes;
    });
    const mappedExport = await b.evaluate(async () => {
      const wb = await profileExportWorkbook();
      return { row: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])[0], formula: wb.Sheets['Keep formula'].A1.f };
    });
    assert.equal(mappedExport.row['Delivered qty'], 1);
    assert.equal(mappedExport.row.Notes, 'Updated');
    assert.equal(mappedExport.row.del_qty, undefined, 'Mapped export updates the source heading rather than making duplicate delivery columns');
    assert.equal(mappedExport.row['Cart quantity'], 3); assert.equal(mappedExport.row.Alternative, 2);
    assert.equal(mappedExport.formula, '1+2');
    for (const bookType of ['xlsx','xls','csv']) {
      const workbook=fx.XLSX.utils.book_new();
      const sheet=fx.XLSX.utils.aoa_to_sheet([]);
      fx.XLSX.utils.sheet_add_aoa(sheet,[['ID','QTY'],[1,3],[],[2,2]],{origin:'B3'});
      sheet['!ref']='B3:C6'; sheet.C4.z='0.00';
      fx.XLSX.utils.book_append_sheet(workbook,sheet,'Stops');
      const name=`Offset-${bookType}.${bookType}`;
      fx.objects.set('excel-files/'+name,new Uint8Array(fx.XLSX.write(workbook,{type:'buffer',bookType})));
      await a.evaluate(name=>openProfileFile({name,sourceKey:name}),name);
      assert.equal(await a.evaluate(()=>_currentRows.length),2);
      const view=await a.evaluate(()=>profileState.workspace);
      await fx.call(accounts.get('team_a@profiles.cartdelivery.invalid'),'save',{fileId:view.fileId,copyRevision:view.copyRevision,edits:[{index:1,values:{del_qty:1,del_status:''}}]});
      await a.evaluate(fileId=>openProfileFile({fileId}),view.fileId);
      const result=await a.evaluate(async()=>{
        const wb=await profileExportWorkbook(),ws=wb.Sheets[wb.SheetNames[0]];
        return {rows:XLSX.utils.sheet_to_json(ws),format:ws.C4?.z};
      });
      assert.equal(result.rows[1].ID,2); assert.equal(result.rows[1].del_qty,1);
      if(bookType!=='csv') assert.equal(result.format,'0.00');
    }
    const duplicate=fx.XLSX.utils.book_new();
    fx.XLSX.utils.book_append_sheet(duplicate,fx.XLSX.utils.aoa_to_sheet([['ID','ID'],[1,2]]),'Stops');
    fx.objects.set('excel-files/Duplicate.xlsx',new Uint8Array(fx.XLSX.write(duplicate,{type:'buffer',bookType:'xlsx'})));
    await a.evaluate(()=>openProfileFile({name:'Duplicate.xlsx',sourceKey:'Duplicate.xlsx'}));
    assert.match(dialogs.pop(),/duplicate column headings/);
    assert.equal((await fx.pg.query("select count(*)::int n from cd_data_files where name='Duplicate.xlsx' and ready")).rows[0].n,0);

    const teamA = accounts.get('team_a@profiles.cartdelivery.invalid');
    const teamB = accounts.get('team_b@profiles.cartdelivery.invalid');
    const badRows = Array.from({ length: 8 }, () => ({ ...rows[0] }));
    badRows[7] = { ...rows[0], LATITUDE: '', QTY: -2, DAY: 'Funday' };
    await a.evaluate(() => openTeamUpload());
    const uploadsBeforeCheck = fx.state.uploads.length;
    await chooseUpload(a, 'Check.xlsx', Buffer.from(fx.workbook(badRows)));
    assert.match(await a.locator('#teamDataCheck').textContent(), /1 of 8 rows need attention/);
    assert.match(await a.locator('#teamDataCheck').textContent(), /Spreadsheet rows: 9/);
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), true);
    await a.locator('#teamDataAccepted').check();
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), false);
    for (const width of [440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      await a.locator('#teamDataCheck').scrollIntoViewIfNeeded();
      await captureProfile(a, 'data-check', '#teamUploadDialog');
    }
    await a.locator('[data-mapping-field="QTY"]').selectOption('BINNO');
    assert.equal(await a.locator('#teamDataAccepted').isChecked(), false, 'Mapping changes clear issue acceptance');
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), true);
    await a.locator('#closeTeamUploadBtn').click();
    assert.equal(fx.state.uploads.length, uploadsBeforeCheck, 'Data checks do not upload sources');
    await chooseUpload(a, 'No coordinates.xlsx', Buffer.from(fx.workbook([{ ...rows[0], LATITUDE: 100 }])));
    assert.match(await a.locator('#teamDataCheck').textContent(), /No stops have usable coordinates/);
    assert.equal(await a.locator('#confirmTeamUploadBtn').isDisabled(), true);
    await a.locator('#closeTeamUploadBtn').click();
    await a.setViewportSize({ width: 440, height: 956 });
    const easeFile = await fx.importRows(teamA, 'Ease.xlsx', rows.map((row, index) => ({ ...row, ROUTE: index === 2 ? 'B' : 'A', DAY: index === 2 ? 2 : 1 })));
    await a.evaluate(fileId => openProfileFile({ fileId }), easeFile.fileId);
    await a.evaluate(() => {
      document.querySelectorAll('#routeCheckboxes input').forEach(input => { input.checked = input.value === 'A'; });
      document.querySelectorAll('#dayCheckboxes input').forEach(input => { input.checked = input.value === '1'; });
      applyFilters(); map.setView([30.75, -98.23], 16, { animate: false });
    });
    const viewBeforeReload = await a.evaluate(() => rememberedDeliveryView());
    await a.reload({ waitUntil: 'networkidle' });
    await a.waitForFunction(fileId => !profileState.busy && profileState.workspace?.fileId === fileId, easeFile.fileId);
    const viewAfterReload = await a.evaluate(() => rememberedDeliveryView());
    assert.deepEqual(viewAfterReload.routes, ['A']); assert.deepEqual(viewAfterReload.days, ['1']);
    assert.deepEqual(viewAfterReload.center, viewBeforeReload.center); assert.equal(viewAfterReload.zoom, 16);
    assert.equal(await a.evaluate(() => Object.values(routeDayGroups).flatMap(group => group.layers).filter(marker => map.hasLayer(marker)).length), 2);
    for (const width of [440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      await a.evaluate(() => Object.values(routeDayGroups).flatMap(group => group.layers).find(marker => marker._rowRef.ID === 0).openPopup());
      await a.locator('.delivery-stop-card').waitFor();
      await a.waitForFunction(() => Number(getComputedStyle(document.querySelector('.leaflet-popup')).opacity) === 1);
      assert.match(await a.locator('.delivery-stop-card').textContent(), /Bin #: 000/);
      assert.match(await a.locator('.delivery-stop-remaining').textContent(), /3 carts remaining/);
      for (const light of [false, true]) {
        await a.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await a.screenshot({ path: path.join(root, `local-artifacts/delivery-stop-${width}-${light ? 'light' : 'dark'}.png`) });
        assert(await a.locator('.stop-delivery-action').evaluate(el => el.getBoundingClientRect().height >= 44));
        assert(await a.locator('.leaflet-popup-close-button').evaluate(el => el.getBoundingClientRect().height >= 44));
        assert(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    await a.locator('.stop-delivery-action').click();
    assert.equal(await a.locator('#cartCountEntries input').count(), 1, 'Single-stop delivery does not require selection');
    await a.locator('#cartCountEntries input').fill('1');
    fx.state.failCommit = true;
    await a.locator('#saveCartCountsBtn').click();
    await a.waitForFunction(() => !deliverySaveInProgress && document.getElementById('deliverySaveStatus').dataset.state === 'error');
    assert.match(await a.locator('#routeContext').textContent(), /Save not confirmed/);
    assert.equal(await a.evaluate(() => _currentRows[0].del_qty), 0);
    fx.state.failCommit = false;
    await a.locator('#saveCartCountsBtn').click();
    await a.waitForFunction(() => !deliverySaveInProgress && _currentRows[0].del_qty === 1);
    assert.match(await a.locator('#routeContext').textContent(), /1 stop waiting to sync/);
    await a.setViewportSize({ width: 440, height: 956 });
    await a.waitForFunction(() => document.getElementById('recordCartsBtn').parentElement.id === 'deliveryMoreActions');
    assert.equal(await a.locator('#recordCartsBtn').evaluate(el => el.parentElement.id), 'deliveryMoreActions');

    const conflictRows = Array.from({ length: 523 }, (_, ID) => ({ ...rows[0], ID, QTY: ID === 522 ? '' : 3, delivery_notes: '' }));
    const conflictFile = await fx.importRows(teamA, 'Bulk conflicts.xlsx', conflictRows);
    const conflictA = await fx.call(teamA, 'open', { fileId: conflictFile.fileId });
    const conflictB = await fx.call(teamB, 'open', { fileId: conflictFile.fileId });
    const conflictEdits = (count, note) => conflictRows.map((row, index) => ({ index, values: {
      del_qty: index === 522 ? '' : count, del_status: index === 522 ? 'Delivered' : '', delivery_notes: index >= 521 ? note : ''
    } }));
    await fx.call(teamA, 'save', { fileId: conflictFile.fileId, copyRevision: conflictA.copyRevision, edits: conflictEdits(1, 'Mine') });
    const conflictSaved = await fx.call(teamB, 'save', { fileId: conflictFile.fileId, copyRevision: conflictB.copyRevision, edits: conflictEdits(2, 'Team') });
    await fx.call(teamB, 'sync', { fileId: conflictFile.fileId, copyRevision: conflictSaved.copyRevision, masterRevision: conflictB.masterRevision, resolutions: [] });
    await a.evaluate(fileId => openProfileFile({ fileId }), conflictFile.fileId);
    await review(a);
    assert.equal(await a.locator('[data-conflict-index]').count(), 0, 'Hundreds of conflicts start with bulk choices, not hundreds of cards');
    assert.match(await a.locator('#profileConflictProgress').textContent(), /0 of 523/);
    const chooseRule = async rule => { await a.locator('#profileConflictRule').selectOption(rule); await a.locator('#profileApplyConflicts').click(); };
    await chooseRule('higher');
    assert.match(await a.locator('#profileConflictProgress').textContent(), /521 of 523/);
    await a.locator('#confirmProfileSyncBtn').click();
    assert.equal(await a.locator('#profileShareDialog').isVisible(), false, 'Higher counts leave differing notes unresolved');
    await chooseRule('original');
    assert.equal(await a.locator('#profileSyncStatus').textContent(), '', 'Changing choices clears the old unresolved-conflict message');
    assert.match(await a.locator('#profileConflictProgress').textContent(), /523 of 523/);
    assert.deepEqual(await a.locator('#profileSyncImpact dd').allTextContents(), ['0', '0', '0', '0']);
    await chooseRule('mine');
    assert.match(await a.locator('#profileSyncImpact .profile-sync-reduction').textContent(), /removes 522 carts/);
    await chooseRule('higher');
    assert.equal(await a.locator('#profileSyncImpact .profile-sync-reduction').count(), 1, 'A retained note conflict choice can still reduce a count');
    await a.locator('#profileConflictDetails summary').click();
    await a.locator('[data-conflict-index]').first().waitFor();
    assert.equal(await a.locator('[data-conflict-index]').count(), 20);
    await a.locator('.profile-conflict-pager').getByRole('button', { name: 'Next', exact: true }).click();
    await a.locator('[data-conflict-index="20"]').selectOption('count');
    await a.locator('[data-conflict-count="20"]').fill('0');
    await a.locator('.profile-conflict-pager').getByRole('button', { name: 'Previous', exact: true }).click();
    await a.locator('.profile-conflict-pager').getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await a.locator('[data-conflict-count="20"]').inputValue(), '0', 'Off-page exceptions are retained');
    await a.locator('#profileConflictDetails summary').click();
    for (const width of [360, 440, 1440]) {
      await a.setViewportSize({ width, height: 956 });
      for (const light of [false, true]) {
        await a.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await a.locator('#profileSyncDialog').evaluate(el => { el.scrollTop = 0; });
        await a.screenshot({ path: path.join(root, `local-artifacts/sync-bulk-${width}-${light ? 'light' : 'dark'}.png`) });
        assert(await a.locator('#profileSyncDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        assert(await a.locator('#profileApplyConflicts').evaluate(el => el.getBoundingClientRect().height >= 44));
        assert(await a.locator('#profileConflictRule').evaluate(el => el.getBoundingClientRect().height >= 44));
      }
    }
    await a.setViewportSize({ width: 440, height: 956 });
    const requestsBeforeBulk = syncRequests;
    await a.locator('#confirmProfileSyncBtn').click();
    assert.equal(syncRequests, requestsBeforeBulk, 'Bulk decisions still require a separate final confirmation');
    assert.equal(await a.evaluate(() => profileState.shareConfirmation.request.resolutions.length), 523, 'All pages are included');
    assert.match(await a.locator('#profileShareImpact .profile-sync-reduction').textContent(), /removes 3 carts/);
    await a.locator('#profileShareAcknowledged').check();
    await a.locator('#commitProfileShareBtn').click();
    await a.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    const bulkActual = await fx.read(teamA, conflictFile.fileId, 'original');
    assert.equal(bulkActual[0].del_qty, 2); assert.equal(bulkActual[520].del_qty, 2);
    assert.equal(bulkActual[20].del_qty, 0); assert.equal(bulkActual[521].del_qty, 1);
    assert.equal(bulkActual[521].delivery_notes, 'Mine'); assert.equal(bulkActual[522].delivery_notes, 'Mine');
    assert.equal((await fx.call(teamA, 'history', { fileId: conflictFile.fileId })).history[0].resolution_count, 523);
    await a.locator('#closeProfileBtn').click();

    const safetyFile = await fx.importRows(teamA, 'Safety.xlsx', rows);
    const safetyCopy = await fx.call(teamA, 'open', { fileId: safetyFile.fileId });
    await fx.call(teamA, 'save', { fileId: safetyFile.fileId, copyRevision: safetyCopy.copyRevision, edits: [{ index: 0, values: { del_qty: 1, del_status: '' } }] });
    await a.evaluate(fileId => openProfileFile({ fileId }), safetyFile.fileId);
    await review(a);
    await a.locator('#confirmProfileSyncBtn').click();
    const otherCopy = await fx.call(teamB, 'open', { fileId: safetyFile.fileId });
    const otherSaved = await fx.call(teamB, 'save', { fileId: safetyFile.fileId, copyRevision: otherCopy.copyRevision, edits: [{ index: 1, values: { del_qty: 1, del_status: '' } }] });
    await fx.call(teamB, 'sync', { fileId: safetyFile.fileId, copyRevision: otherSaved.copyRevision, masterRevision: otherCopy.masterRevision, resolutions: [] });
    await a.locator('#profileShareAcknowledged').check();
    await a.locator('#commitProfileShareBtn').click();
    await a.waitForFunction(() => !profileState.busy);
    assert.match(await a.locator('#profileShareStatus').textContent(), /changed on another device/);
    assert.equal(await a.locator('#profileShareAcknowledged').isChecked(), false, 'Failed sharing requires a fresh acknowledgement');
    assert.equal(await a.locator('#commitProfileShareBtn').isDisabled(), true);
    assert.deepEqual((await fx.read(teamA, safetyFile.fileId, 'original')).map(row => row.del_qty), [0, 1, 0], 'Team changes after review block stale confirmation without overwriting anything');
    assert.deepEqual(await a.evaluate(() => _currentRows.map(row => row.del_qty)), [1, 0, 0], 'Failed confirmation leaves the open copy unchanged');
    await a.locator('#profileShareAcknowledged').check();
    await a.evaluate(() => sb.auth.signOut());
    await a.waitForFunction(() => !profileState.user);
    assert.equal(await a.locator('#profileShareDialog').isVisible(), false, 'Account changes close the final check');
    assert.equal(await a.evaluate(() => profileState.shareConfirmation), null);
    assert.deepEqual(errors, []);
    console.log('PASS: profile flows, final acknowledgement, cancel/Escape, duplicate taps, conflicts, stale confirmation, account changes, lost-response retry, history, cross-device resume, phone/desktop themes. No live storage.');
  } finally { if (browser) await browser.close(); await fx.pg.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
