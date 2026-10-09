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
          if (url.pathname.includes('_cart-delivery-tab.json')) return json(['Trash.xlsx']);
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
    const signup = async (page, username) => {
      await page.locator('#profileWorkspaceBtn').click();
      await page.locator('#profileUsername').fill(username); await page.locator('#profilePassword').fill('test-password');
      await page.locator('#createProfileBtn').click();
      await page.waitForFunction(() => profileState.user !== null && !profileState.busy);
      assert.equal(await page.locator('#profileAccountName').textContent(), username.toLowerCase());
    };
    await signup(a, 'Team_A'); await signup(b, 'team_b');
    const rows = [0, 1, 2].map(index => ({ ID: index, QTY: 3, ROUTE: 'A', DAY: 1, 'CSADR#': 100 + index, CSSTRT: 'Test', BINNO: `00${index}`, LATITUDE: 30.75 + index * .001, LONGITUDE: -98.23, del_qty: 0, del_status: '' }));
    fx.objects.set('excel-files/Trash.xlsx', fx.workbook(rows));
    await a.locator('#profileChooseFileBtn').click();
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
    assert.deepEqual(await a.evaluate(() => _currentRows.map(row => row.del_qty)), [0, 0, 0]);
    while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 10));
    delaySave = false; releaseSave();
    await a.waitForFunction(() => !deliverySaveInProgress && _currentRows[0].del_qty === 1);
    await deliver(b, [1, 2]); await b.waitForFunction(() => !deliverySaveInProgress && _currentRows[1].del_qty === 1);
    assert.deepEqual((await fx.read(accounts.get('team_a@profiles.cartdelivery.invalid'), await a.evaluate(() => profileState.workspace.fileId), 'original')).map(row => row.del_qty), [0, 0, 0]);
    const review = async page => { await page.locator('#profileWorkspaceBtn').click(); await page.locator('#profileReviewBtn').click(); await page.waitForFunction(() => profileState.preview !== null && !profileState.busy); };
    await review(a); loseSyncResponse = true;
    await a.locator('#confirmProfileSyncBtn').click();
    await a.waitForFunction(() => !profileState.busy && profileState.workspace.pending === 0);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_history')).rows[0].n, 1, 'Lost response retry syncs once');
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
    const uploadBytes=Buffer.from(fx.workbook(rows)).toString('base64');
    await a.evaluate(async base64=>{
      const file=new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'New.xlsx');
      await uploadFile(file);
    },uploadBytes);
    assert.equal(await a.evaluate(()=>profileState.workspace.name),'New.xlsx');
    assert.equal(fx.state.uploads.length,1,'A new source workbook uploads once with a signed ticket');
    assert.deepEqual(await a.evaluate(()=>_currentRows.map(row=>row.del_qty)),[0,0,0]);
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
    assert.deepEqual(errors, []);
    console.log('PASS: two profiles end to end, username uniqueness/sign-in, delayed saves, explicit sync, overlap review, lost-response retry, history, original read-only, cross-device resume, phone/desktop themes. No live storage.');
  } finally { if (browser) await browser.close(); await fx.pg.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
